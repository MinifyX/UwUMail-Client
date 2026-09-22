import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import type { Identity, Signature } from "@/backend/types";
import { useAccountSync } from "@/state/accountSync";
import { Signatures } from "./Signatures";

const identity = { id: "i1", accountId: "a1", email: "mini@example.org", name: "Mini" } as Identity;
const signature: Signature = {
  id: "s1",
  email: "mini@example.org",
  name: "Gruß",
  html: "<p>Liebe Grüße</p>",
  forNew: true,
  forReplies: false,
};

vi.mock("@/backend/backend", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/backend/backend")>()),
  backend: () => ({
    listIdentities: () => Promise.resolve([identity]),
    listSignatures: () => Promise.resolve([signature]),
  }),
}));

describe("Signatures", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("de");
  });

  // Vitest runs without globals here, so the automatic cleanup is not registered.
  afterEach(cleanup);

  it("renders without a sync account instead of looping until React gives up", async () => {
    // No UwUMail server with the settings extension: the app has no sync account. The section used to
    // select a fresh [] on every render here, which ended in a black window.
    useAccountSync.setState({ accountId: null, unsynced: [] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Signatures />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Gruß")).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
