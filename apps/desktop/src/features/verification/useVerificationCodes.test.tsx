import "@/test/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VerificationCode } from "./types";
import { nextRefreshMs, useVerificationCodes, validCodes } from "./useVerificationCodes";

const NOW = Date.parse("2026-11-02T10:00:00Z");

const code = (id: string, seconds: number): VerificationCode => ({
  id,
  accountId: "acc",
  emailId: id,
  threadId: `thr-${id}`,
  kind: "otp",
  code: "482913",
  origin: "bank.example",
  sender: "Bank",
  purpose: "login",
  source: "header",
  autofill: false,
  expiresAt: new Date(NOW + seconds * 1000).toISOString(),
});

let served: VerificationCode[] = [];
const fake = { verificationCodes: vi.fn(async () => served) };

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useVerificationCodes", () => {
  afterEach(() => {
    cleanup();
    served = [];
    fake.verificationCodes.mockClear();
  });

  it("shows the codes the backend has, without those already run out", async () => {
    const now = Date.now();
    served = [
      { ...code("m1", 0), expiresAt: new Date(now + 120_000).toISOString() },
      { ...code("m2", 0), expiresAt: new Date(now - 1_000).toISOString() },
    ];
    const { result } = renderHook(() => useVerificationCodes(), { wrapper });
    await waitFor(() => expect(result.current.map((c) => c.id)).toEqual(["m1"]));
    expect(fake.verificationCodes).toHaveBeenCalledTimes(1);
  });

  it("asks again when the earliest code runs out, at least once a minute", () => {
    expect(nextRefreshMs([], NOW)).toBe(60_000);
    expect(nextRefreshMs([code("a", 600), code("b", 20)], NOW)).toBe(20_500);
    // Already over: soon, but not in a loop.
    expect(nextRefreshMs([code("c", -5)], NOW)).toBe(1_000);
  });

  it("drops codes past their expiry", () => {
    expect(validCodes([code("a", 1), code("b", 0), code("c", -1)], NOW).map((c) => c.id)).toEqual(["a"]);
  });
});
