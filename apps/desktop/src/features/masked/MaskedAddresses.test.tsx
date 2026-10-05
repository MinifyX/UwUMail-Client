import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "@/backend/backend";
import type { MaskedAddress, MaskedAddressInput, MaskedOptions } from "@/backend/types";
import { i18n } from "@/i18n";
import { useSettings } from "@/state/settings";
import { useToasts } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { SettingsDialog } from "../settings/SettingsDialog";
import { MaskedAddresses } from "./MaskedAddresses";

const masked = (patch: Partial<MaskedAddress> & Pick<MaskedAddress, "id" | "email">): MaskedAddress => ({
  state: "enabled",
  forDomain: "",
  description: "",
  url: null,
  createdAt: "2026-09-01T10:00:00Z",
  lastMessageAt: null,
  createdBy: "Portal",
  ...patch,
});

const START = [
  masked({
    id: "x1",
    email: "fern.otter804@mask.example",
    description: "Library",
    forDomain: "https://library.example.org",
    createdAt: "2026-03-01T10:00:00Z",
    lastMessageAt: "2026-09-20T10:00:00Z",
  }),
  masked({
    id: "x3",
    email: "maple.otter482@mask.example",
    description: "Shop",
    forDomain: "https://shop.example.com",
    createdAt: "2026-09-20T10:00:00Z",
  }),
  masked({ id: "x2", email: "pebble.badger731@mask.example", description: "Giveaway", state: "disabled" }),
  masked({ id: "x0", email: "cloud.lantern55@mask.example", description: "Old newsletter", state: "deleted" }),
];

let list: MaskedAddress[] = [];
let options: MaskedOptions | null = null;

const fake = {
  kind: "jmap",
  listAccounts: vi.fn(async () => [{ id: "acc", email: "mini@uwumail.example" }]),
  mailRulesAvailable: vi.fn(async () => false),
  ruleAccounts: vi.fn(async () => []),
  assistScopes: vi.fn(async () => []),
  serverAccountFeatures: vi.fn(async () => (options ? [{ accountId: "acc", masked: options, profile: null }] : [])),
  maskedAddresses: vi.fn(async (_accountId: string) => list.map((item) => ({ ...item }))),
  createMaskedAddress: vi.fn(async (_accountId: string, input: MaskedAddressInput): Promise<MaskedAddress> => {
    const made = masked({
      id: "x9",
      email: `${input.emailPrefix ? `${input.emailPrefix}.` : ""}comet.fern217@${input.domain ?? "mask.example"}`,
      description: input.description,
      forDomain: input.forDomain,
      url: input.url,
      createdAt: "2026-09-27T10:00:00Z",
    });
    list = [made, ...list];
    return made;
  }),
  updateMaskedAddress: vi.fn(async (_accountId: string, id: string, patch: Partial<MaskedAddress>) => {
    list = list.map((item) => (item.id === id ? { ...item, ...patch } : item));
  }),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

const writeText = vi.fn(async (_text: string) => {});

function renderMasked(node = <MaskedAddresses accountId="acc" options={options!} />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** The list's entry for an address. */
async function row(email: string) {
  return within(await screen.findByRole("list", { name: "Masked addresses" })).findByRole("listitem", {
    name: email,
  });
}

describe("masked addresses", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    list = START.map((item) => ({ ...item }));
    options = { domains: ["mask.example", "uwumail.example"], defaultDomain: "mask.example" };
  });
  afterEach(() => {
    cleanup();
    act(() => useToasts.setState({ toasts: [] }));
  });

  it("lists the active ones newest first and finds the others by state and search", async () => {
    renderMasked();
    const listed = await screen.findByRole("list", { name: "Masked addresses" });
    await waitFor(() =>
      expect(
        within(listed)
          .getAllByRole("listitem")
          .map((item) => item.getAttribute("aria-label")),
      ).toEqual(["maple.otter482@mask.example", "fern.otter804@mask.example"]),
    );
    expect(within(listed).getByText("Library · library.example.org")).toBeTruthy();
    expect(within(listed).getAllByText(/no mail yet/)).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: "Deleted 1" }));
    expect(await row("cloud.lantern55@mask.example")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "Active 2" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search masked addresses" }), {
      target: { value: "library" },
    });
    await waitFor(() => expect(within(listed).getAllByRole("listitem")).toHaveLength(1));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search masked addresses" }), {
      target: { value: "nothing like it" },
    });
    expect(await screen.findByText("No masked address matches your search.")).toBeTruthy();
  });

  it("makes one with a prefix on the chosen domain and shows it to copy", async () => {
    renderMasked();
    fireEvent.click(await screen.findByRole("button", { name: "New masked address" }));
    const form = screen.getByRole("form", { name: "New masked address" });
    const domain = within(form).getByLabelText<HTMLSelectElement>("Domain");
    // The server's default comes preselected.
    expect(domain.value).toBe("mask.example");
    fireEvent.change(within(form).getByLabelText("Description"), { target: { value: "Bakery" } });
    fireEvent.change(within(form).getByLabelText("Website"), { target: { value: "bakery.example.com" } });
    fireEvent.change(within(form).getByLabelText("Prefix (optional)"), { target: { value: "Cake" } });
    fireEvent.change(domain, { target: { value: "uwumail.example" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create address" }));

    const made = await screen.findByRole("status");
    expect(within(made).getByText("cake.comet.fern217@uwumail.example")).toBeTruthy();
    expect(fake.createMaskedAddress).toHaveBeenCalledWith("acc", {
      description: "Bakery",
      forDomain: "https://bakery.example.com",
      url: null,
      emailPrefix: "cake",
      domain: "uwumail.example",
    });
    fireEvent.click(within(made).getByRole("button", { name: "Copy cake.comet.fern217@uwumail.example" }));
    expect(writeText).toHaveBeenCalledWith("cake.comet.fern217@uwumail.example");
    expect(await row("cake.comet.fern217@uwumail.example")).toBeTruthy();
  });

  it("explains a prefix the server wouldn't take and doesn't send it", async () => {
    renderMasked();
    fireEvent.click(await screen.findByRole("button", { name: "New masked address" }));
    const form = screen.getByRole("form", { name: "New masked address" });
    fireEvent.change(within(form).getByLabelText("Prefix (optional)"), { target: { value: "my-shop" } });
    expect(within(form).getByRole("alert").textContent).toBe(
      "Only lower-case letters a–z, digits and _, at most 64 characters.",
    );
    const create = within(form).getByRole<HTMLButtonElement>("button", { name: "Create address" });
    expect(create.disabled).toBe(true);
    fireEvent.submit(form);
    expect(fake.createMaskedAddress).not.toHaveBeenCalled();
  });

  it("says in plain words when the server refuses the domain", async () => {
    fake.createMaskedAddress.mockRejectedValueOnce(new BackendError("forbidden", "domain not allowed for account 7"));
    renderMasked();
    fireEvent.click(await screen.findByRole("button", { name: "New masked address" }));
    const form = screen.getByRole("form", { name: "New masked address" });
    fireEvent.click(within(form).getByRole("button", { name: "Create address" }));
    expect((await within(form).findByRole("alert")).textContent).toMatch(/the domain isn't allowed for you/);
  });

  it("offers no domain choice with one domain, or when the server doesn't name any", async () => {
    options = { domains: ["mask.example"], defaultDomain: "mask.example" };
    const first = renderMasked();
    fireEvent.click(await screen.findByRole("button", { name: "New masked address" }));
    expect(screen.queryByLabelText("Domain")).toBeNull();
    expect(screen.getByText("New addresses end in @mask.example.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create address" }));
    await waitFor(() => expect(fake.createMaskedAddress).toHaveBeenCalledTimes(1));
    expect(fake.createMaskedAddress.mock.calls[0]![1]).not.toHaveProperty("domain");
    first.unmount();

    options = { domains: null, defaultDomain: null };
    renderMasked();
    fireEvent.click(await screen.findByRole("button", { name: "New masked address" }));
    expect(screen.queryByLabelText("Domain")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create address" }));
    await waitFor(() => expect(fake.createMaskedAddress).toHaveBeenCalledTimes(2));
    expect(fake.createMaskedAddress.mock.calls[1]![1]).not.toHaveProperty("domain");
  });

  it("explains that the admin hasn't enabled them, and keeps the existing ones manageable", async () => {
    options = { domains: [], defaultDomain: null };
    renderMasked();
    expect(await screen.findByText("Masked addresses aren't enabled for you")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New masked address" })).toBeNull();
    expect(await row("maple.otter482@mask.example")).toBeTruthy();
  });

  it("switches one off, deletes one with undo and restores a deleted one", async () => {
    renderMasked();
    fireEvent.click(
      within(await row("maple.otter482@mask.example")).getByRole("switch", {
        name: "maple.otter482@mask.example on or off",
      }),
    );
    await waitFor(() => expect(fake.updateMaskedAddress).toHaveBeenCalledWith("acc", "x3", { state: "disabled" }));

    fireEvent.click(
      within(await row("fern.otter804@mask.example")).getByRole("button", {
        name: "Delete fern.otter804@mask.example",
      }),
    );
    await waitFor(() => expect(fake.updateMaskedAddress).toHaveBeenLastCalledWith("acc", "x1", { state: "deleted" }));
    const toast = await waitFor(() => {
      const found = useToasts.getState().toasts.find((item) => item.action);
      expect(found?.message).toBe("fern.otter804@mask.example deleted. Mail to it is refused now.");
      return found!;
    });
    act(() => toast.action!.run());
    await waitFor(() => expect(fake.updateMaskedAddress).toHaveBeenLastCalledWith("acc", "x1", { state: "enabled" }));

    fireEvent.click(screen.getByRole("radio", { name: /^Deleted/ }));
    fireEvent.click(within(await row("cloud.lantern55@mask.example")).getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(fake.updateMaskedAddress).toHaveBeenLastCalledWith("acc", "x0", { state: "enabled" }));
  });

  it("edits the description, site and link, sending only what changed", async () => {
    renderMasked();
    fireEvent.click(
      within(await row("maple.otter482@mask.example")).getByRole("button", {
        name: "Edit maple.otter482@mask.example",
      }),
    );
    const editor = await row("maple.otter482@mask.example");
    fireEvent.change(within(editor).getByLabelText("Description"), { target: { value: "Shop (old account)" } });
    fireEvent.change(within(editor).getByLabelText("Link (optional)"), {
      target: { value: "https://shop.example.com/me" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fake.updateMaskedAddress).toHaveBeenCalledWith("acc", "x3", {
        description: "Shop (old account)",
        url: "https://shop.example.com/me",
      }),
    );
    await waitFor(() => expect(within(screen.getByRole("list")).queryByLabelText("Description")).toBeNull());
  });
});

describe("the settings section", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
    useSettings.getState().update({ tone: "neutral" });
  });
  afterEach(() => {
    cleanup();
    act(() => useUi.getState().closeSettings());
  });

  it("is there only when the server makes masked addresses for the account", async () => {
    options = null;
    const first = renderMasked(<SettingsDialog />);
    act(() => useUi.getState().openSettings("appearance"));
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    await waitFor(() => expect(fake.serverAccountFeatures).toHaveBeenCalled());
    expect(within(nav).queryByRole("button", { name: "Masked addresses" })).toBeNull();
    first.unmount();

    options = { domains: ["mask.example"], defaultDomain: "mask.example" };
    renderMasked(<SettingsDialog />);
    fireEvent.click(await screen.findByRole("button", { name: "Masked addresses" }));
    expect(await screen.findByRole("button", { name: "New masked address" })).toBeTruthy();
  });
});
