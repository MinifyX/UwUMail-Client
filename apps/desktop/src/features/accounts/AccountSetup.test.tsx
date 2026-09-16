import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { Account, DiscoveredSettings, NewAccount } from "@/backend/types";
import { AccountSetup } from "./AccountSetup";

const discoverSettings = vi.fn<(email: string) => Promise<DiscoveredSettings>>();
const addAccount = vi.fn<(account: NewAccount) => Promise<Account>>();
const microsoftAdminConsentUrl = vi.fn<(email: string) => Promise<string>>();

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => ({ discoverSettings, addAccount, microsoftAdminConsentUrl }),
}));

/** What discovery returns for a company domain it could not place. */
const guessed: DiscoveredSettings = {
  email: "alex@example-company.de",
  imap: { host: "imap.example-company.de", port: 993, security: "tls" },
  smtp: { host: "smtp.example-company.de", port: 465, security: "tls" },
  username: "alex@example-company.de",
  source: "guess",
};

const added: Account = {
  id: "a1",
  name: "Alex",
  email: "alex@example-company.de",
  displayName: "Alex",
  color: "pink",
  auth: "microsoft",
  status: { state: "idle" },
  protocol: "imap",
  protocols: ["imap"],
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AccountSetup onDone={() => {}} />
    </QueryClientProvider>,
  );
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/** Walks the first step: type the address and let discovery answer. */
async function discover() {
  fireEvent.change(screen.getByLabelText("E-Mail-Adresse"), { target: { value: guessed.email } });
  click("Weiter");
  await screen.findByLabelText("Passwort");
}

describe("AccountSetup with Microsoft 365", () => {
  // jsdom reports en-US, and these assertions read the German wording.
  beforeAll(async () => {
    await i18n.changeLanguage("de");
  });

  beforeEach(() => {
    discoverSettings.mockReset().mockResolvedValue(guessed);
    addAccount.mockReset().mockResolvedValue(added);
    microsoftAdminConsentUrl
      .mockReset()
      .mockResolvedValue("https://login.microsoftonline.com/example-company.de/adminconsent?client_id=abc");
  });

  // Vitest runs without globals here, so the automatic cleanup is not registered.
  afterEach(cleanup);

  it("lets a company mailbox switch to Microsoft when discovery missed it", async () => {
    setup();
    await discover();

    click("Dieses Postfach liegt bei Microsoft 365");

    // The password is gone, because Exchange Online does not take one.
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    click("Weiter mit Microsoft");

    await waitFor(() => expect(addAccount).toHaveBeenCalledTimes(1));
    expect(addAccount.mock.calls[0]![0]).toMatchObject({
      auth: "microsoft",
      email: guessed.email,
      imap: { host: "outlook.office365.com", port: 993, security: "tls" },
      smtp: { host: "smtp.office365.com", port: 587, security: "starttls" },
      password: undefined,
    });
  });

  it("sends a shared mailbox the address that signs in for it", async () => {
    setup();
    await discover();
    click("Dieses Postfach liegt bei Microsoft 365");

    click("Gemeinsames Postfach");
    fireEvent.change(await screen.findByLabelText("Anmelden als"), {
      target: { value: "alex@example-company.de" },
    });
    click("Weiter mit Microsoft");

    await waitFor(() => expect(addAccount).toHaveBeenCalledTimes(1));
    expect(addAccount.mock.calls[0]![0]).toMatchObject({
      username: guessed.email,
      signInAs: "alex@example-company.de",
    });
  });

  it("goes back to a password and shows the servers, which are wrong by then", async () => {
    setup();
    await discover();
    click("Dieses Postfach liegt bei Microsoft 365");
    click("Stattdessen mit Passwort anmelden");

    expect(await screen.findByLabelText("Passwort")).toBeTruthy();
    expect(screen.getByLabelText("Benutzername")).toBeTruthy();
  });

  it("explains a mailbox whose administrator switched IMAP off", async () => {
    const { BackendError } = await import("@/backend/backend");
    addAccount.mockRejectedValue(new BackendError("imap_disabled", "IMAP is switched off for this mailbox."));
    setup();
    await discover();
    click("Dieses Postfach liegt bei Microsoft 365");
    click("Weiter mit Microsoft");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("IMAP abgeschaltet");
    expect(alert.textContent).toContain("Set-CASMailbox");
  });

  it("hands a refused company sign-in the link for its administrators", async () => {
    const { BackendError } = await import("@/backend/backend");
    addAccount.mockRejectedValue(new BackendError("admin_consent_required", "Needs an administrator."));
    setup();
    await discover();
    click("Dieses Postfach liegt bei Microsoft 365");
    click("Weiter mit Microsoft");

    expect((await screen.findByRole("alert")).textContent).toContain("Administration zugestimmt");
    expect(await screen.findByText(/adminconsent/)).toBeTruthy();
  });

  it("offers the link after any refused Microsoft sign-in, not only the named one", async () => {
    // Microsoft often shows its approval page instead of naming a reason.
    const { BackendError } = await import("@/backend/backend");
    addAccount.mockRejectedValue(new BackendError("auth_failed", "Sign-in was cancelled (access_denied)."));
    setup();
    await discover();
    click("Dieses Postfach liegt bei Microsoft 365");
    click("Weiter mit Microsoft");

    expect(await screen.findByText(/adminconsent/)).toBeTruthy();
  });

  it("keeps the link away from refusals an administrator cannot help with", async () => {
    const { BackendError } = await import("@/backend/backend");
    addAccount.mockRejectedValue(new BackendError("oauth_not_configured", "No client id in this build."));
    setup();
    await discover();
    click("Dieses Postfach liegt bei Microsoft 365");
    click("Weiter mit Microsoft");

    expect((await screen.findByRole("alert")).textContent).toContain("Zugangsdaten");
    expect(screen.queryByText(/adminconsent/)).toBeNull();
  });
});
