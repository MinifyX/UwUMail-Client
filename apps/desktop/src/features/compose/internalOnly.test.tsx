import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerAccountFeatures } from "@/backend/types";
import { i18n } from "@/i18n";
import { isInternal } from "@/lib/internalOnly";
import { useInternalDomains } from "./internalOnly";
import { RecipientInput } from "./RecipientInput";

const features: ServerAccountFeatures[] = [
  { accountId: "inside", internalDomains: ["team.example", "uwumail.test"] } as ServerAccountFeatures,
  { accountId: "older" } as ServerAccountFeatures,
];

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => ({
    serverAccountFeatures: () => Promise.resolve(features),
    suggestRecipients: () => Promise.resolve([]),
    subscribe: () => () => {},
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("internal-only mailboxes in compose", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(cleanup);

  it("reads the allowed domains per account; none means no restriction", async () => {
    const inside = renderHook(() => useInternalDomains("inside"), { wrapper });
    await waitFor(() => expect(inside.result.current).toEqual(["team.example", "uwumail.test"]));
    const older = renderHook(() => useInternalDomains("older"), { wrapper });
    const unknown = renderHook(() => useInternalDomains("imap-account"), { wrapper });
    await waitFor(() => expect(older.result.current).toBeNull());
    expect(unknown.result.current).toBeNull();
  });

  it("marks recipients outside the server's domains and says why", () => {
    const domains = ["team.example"];
    render(
      <RecipientInput
        label="To"
        value={[{ email: "kim@Team.example", name: "Kim" }, { email: "lou@example.com" }]}
        onChange={() => {}}
        isUndeliverable={(address) => !isInternal(address.email, domains)}
      />,
      { wrapper },
    );
    const outside = screen.getByTitle(/lou@example\.com can't be reached/);
    expect(outside.dataset.undeliverable).toBe("true");
    expect(outside.textContent).toMatch(/this account may only send to addresses on this server/);
    const inside = screen.getByTitle("kim@Team.example");
    expect(inside.dataset.undeliverable).toBeUndefined();
    expect(screen.getByRole("button", { name: /lou@example\.com/ })).toBeTruthy();
  });

  it("marks nothing without a restriction", () => {
    render(<RecipientInput label="To" value={[{ email: "lou@example.com" }]} onChange={() => {}} />, { wrapper });
    expect(screen.getByTitle("lou@example.com").dataset.undeliverable).toBeUndefined();
  });
});
