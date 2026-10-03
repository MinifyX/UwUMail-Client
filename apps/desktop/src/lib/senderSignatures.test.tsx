import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Identity, Signature } from "@/backend/types";
import { SERVER_SIGNATURES_WAIT_MS, useSenderSignatures } from "./queries";

const own: Signature = {
  id: "s1",
  email: "mini@uwumail.example",
  name: "Mini",
  html: "<p>Mini</p>",
  forNew: true,
  forReplies: true,
};
const identity: Identity = {
  id: "a1",
  accountId: "a1",
  email: "mini@uwumail.example",
  name: "Mini",
  primary: true,
  fromServer: false,
};

const fake = {
  listSignatures: vi.fn(async () => [own]),
  listIdentities: vi.fn(async () => [identity]),
  // A server that never answers.
  domainSignatures: vi.fn(() => new Promise<never>(() => {})),
};

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => vi.useRealTimers());

describe("useSenderSignatures", () => {
  it("goes with the device's signatures when a server takes too long (C-4)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useSenderSignatures(), { wrapper: wrapper() });
    await waitFor(() => expect(fake.listSignatures).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
    vi.advanceTimersByTime(SERVER_SIGNATURES_WAIT_MS + 10);
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current!.some((signature) => signature.id === "s1")).toBe(true);
  });
});
