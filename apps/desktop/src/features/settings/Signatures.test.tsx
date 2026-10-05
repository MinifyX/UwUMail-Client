import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { AccountDomainSignatures, Identity, Signature } from "@/backend/types";
import type { DomainSignatureChange } from "@/lib/domainSignatures";
import { useAccountSync } from "@/state/accountSync";
import { useSettings } from "@/state/settings";
import { useToasts } from "@/state/toasts";
import { Signatures } from "./Signatures";

const identity = (accountId: string, email: string, name = "Mini"): Identity => ({
  id: `${accountId}:${email}`,
  accountId,
  email,
  name,
  primary: false,
  fromServer: false,
});

/** Account "u" on a UwUMail server with signatures per domain; "g" anywhere else. */
let identities: Identity[] = [];
let signatures: Signature[] = [];
let servers: AccountDomainSignatures[] = [];

const server = (): AccountDomainSignatures => ({
  accountId: "u",
  overview: {
    state: "3",
    allDomains: null,
    domains: [
      {
        domain: "example.net",
        addressCount: 1,
        signature: { text: "Net", html: "<p>Net</p>" },
        company: null,
        source: "domain",
      },
      {
        domain: "example.org",
        addressCount: 2,
        signature: null,
        company: { mode: "footer", text: "Beispiel GmbH · {name}", html: "" },
        source: "none",
      },
    ],
    identities: [
      {
        id: "i1",
        name: "Mini",
        email: "mini@example.net",
        domain: "example.net",
        signature: null,
        effective: { text: "Net", html: "<p>Net</p>" },
        source: "domain",
      },
      {
        id: "i2",
        name: "Mini",
        email: "mini@example.org",
        domain: "example.org",
        signature: null,
        effective: { text: "", html: "" },
        source: "none",
      },
      {
        id: "i3",
        name: "Info",
        email: "info@example.org",
        domain: "example.org",
        signature: { text: "Info", html: "" },
        effective: { text: "Info", html: "" },
        source: "identity",
      },
    ],
  },
});

const fake = {
  listAccounts: vi.fn(async () => [
    { id: "u", email: "mini@example.net" },
    { id: "g", email: "mini@mail.example" },
  ]),
  listIdentities: vi.fn(async () => identities),
  listSignatures: vi.fn(async () => signatures),
  domainSignatures: vi.fn(async () => servers),
  saveDomainSignatures: vi.fn(async (_accountId: string, _change: DomainSignatureChange) => servers[0]!),
  saveSignature: vi.fn(async (signature: Signature) => signature),
  deleteSignature: vi.fn(async (_id: string) => {}),
};

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Signatures />
    </QueryClientProvider>,
  );
}

/** Types into a rich editor on the page, as the composer's cleaner sees it. */
function write(html: string, index = 0) {
  const editor = screen.getAllByRole("textbox", { name: "Signatures" })[index]!;
  editor.innerHTML = html;
}

async function pick(label: string) {
  const select = (await screen.findByRole("combobox", { name: "Domain" })) as HTMLSelectElement;
  const option = [...select.options].find((candidate) => candidate.textContent === label)!;
  fireEvent.change(select, { target: { value: option.value } });
}

describe("Signatures", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    useAccountSync.setState({ accountId: null, unsynced: [] });
    identities = [
      identity("u", "mini@example.net"),
      identity("u", "mini@example.org"),
      identity("u", "info@example.org", "Info"),
      identity("g", "mini@mail.example"),
      identity("g", "team@mail.example", "Team"),
    ];
    signatures = [];
    servers = [server()];
  });
  // Vitest runs without globals here, so the automatic cleanup is not registered.
  afterEach(() => {
    cleanup();
    act(() => useToasts.setState({ toasts: [] }));
  });

  it("renders without a sync account instead of looping until React gives up", async () => {
    // No UwUMail server with the settings extension: the app has no sync account. The section used to
    // select a fresh [] on every render here, which ended in a black window.
    servers = [];
    signatures = [
      { id: "s1", email: "mini@mail.example", name: "Gruß", html: "<p>Hi</p>", forNew: true, forReplies: false },
    ];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    renderPage();
    await pick("mail.example (2 addresses)");
    expect(await screen.findByText("Gruß")).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("lists the server's domains and the device's, each with its address count", async () => {
    renderPage();
    const select = (await screen.findByRole("combobox", { name: "Domain" })) as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "example.net (1 address)",
      "example.org (2 addresses)",
      "mail.example (2 addresses)",
    ]);
    expect(screen.getByText(/Lives on your UwUMail server/)).toBeTruthy();
    await pick("mail.example (2 addresses)");
    expect(await screen.findByText(/Stays on this device/)).toBeTruthy();
  });

  it("saves one signature for a server domain, with its company footer shown", async () => {
    renderPage();
    await pick("example.org (2 addresses)");
    // The company footer of the domain, with the placeholders filled for its first address.
    expect(await screen.findByText("Beispiel GmbH · Mini")).toBeTruthy();
    expect(screen.getByText("Different signature for single addresses (1)")).toBeTruthy();
    write("<p>Gruß, {name}</p>");
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    await waitFor(() => expect(fake.saveDomainSignatures).toHaveBeenCalled());
    expect(fake.saveDomainSignatures.mock.calls[0]).toEqual([
      "u",
      { domains: { "example.org": { text: "Gruß, {name}", html: "<p>Gruß, {name}</p>" } }, ifInState: "3" },
    ]);
  });

  it("applies one server signature to all its domains, replacing the domains' own", async () => {
    renderPage();
    await screen.findByRole("combobox", { name: "Domain" });
    fireEvent.click(screen.getByRole("checkbox", { name: "All domains (including future ones)" }));
    write("<p>Für alle</p>");
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    await waitFor(() => expect(fake.saveDomainSignatures).toHaveBeenCalled());
    expect(fake.saveDomainSignatures.mock.calls[0]![1]).toEqual({
      domains: { "*": { text: "Für alle", html: "<p>Für alle</p>" }, "example.net": null },
      ifInState: "3",
    });
  });

  it("lets a server address differ and go back to the domain's", async () => {
    renderPage();
    await pick("example.org (2 addresses)");
    fireEvent.click(await screen.findByRole("button", { name: "Own signature for this address" }));
    // Editors: the domain's, Mini's new one, Info's own.
    write("<p>Nur Mini</p>", 1);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]!);
    await waitFor(() => expect(fake.saveDomainSignatures).toHaveBeenCalled());
    expect(fake.saveDomainSignatures.mock.calls[0]![1]).toEqual({
      identities: { i2: { text: "Nur Mini", html: "<p>Nur Mini</p>" } },
      ifInState: "3",
    });
    fake.saveDomainSignatures.mockClear();
    fireEvent.click(screen.getAllByRole("button", { name: "Use the domain signature" }).at(-1)!);
    await waitFor(() =>
      expect(fake.saveDomainSignatures).toHaveBeenCalledWith("u", { identities: { i3: null }, ifInState: "3" }),
    );
  });

  it("reloads and says so when another device changed the signatures (WF-3)", async () => {
    const { BackendError } = await import("@/backend/backend");
    fake.saveDomainSignatures.mockRejectedValueOnce(new BackendError("state_mismatch", "changed"));
    renderPage();
    await pick("example.org (2 addresses)");
    const reads = fake.domainSignatures.mock.calls.length;
    write("<p>Neu</p>");
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
    await waitFor(() => expect(fake.domainSignatures.mock.calls.length).toBeGreaterThan(reads));
    expect(useToasts.getState().toasts.map((toast) => toast.message)).toEqual([
      "The signatures were changed elsewhere in the meantime. They have been reloaded; please check them and save again.",
    ]);
  });

  it("keeps a device domain's signature on the device", async () => {
    signatures = [{ id: "old", email: "@mail.example", name: "", html: "<p>Alt</p>", forNew: true, forReplies: true }];
    renderPage();
    await pick("mail.example (2 addresses)");
    write("<p>{name} · {domain}</p>");
    fireEvent.click((await screen.findAllByRole("button", { name: "Save" }))[0]!);
    await waitFor(() => expect(fake.saveSignature).toHaveBeenCalled());
    expect(fake.saveSignature).toHaveBeenCalledWith({
      id: "old",
      email: "@mail.example",
      name: "",
      html: "<p>{name} · {domain}</p>",
      forNew: true,
      forReplies: true,
    });
    expect(fake.saveDomainSignatures).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove signature" }));
    await waitFor(() => expect(fake.deleteSignature).toHaveBeenCalledWith("old"));
  });

  it("shows device signatures that go before the server's, so they can be removed", async () => {
    signatures = [
      { id: "s1", email: "mini@example.net", name: "Lang", html: "<p>Lang</p>", forNew: true, forReplies: true },
    ];
    renderPage();
    expect(await screen.findByText(/In this app these addresses have signatures of their own/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete Lang" }));
    await waitFor(() => expect(fake.deleteSignature).toHaveBeenCalledWith("s1"));
  });
});
