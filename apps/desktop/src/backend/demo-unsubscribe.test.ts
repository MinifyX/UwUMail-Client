import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoBackend } from "./demo";

/** The demo's newsletters, by sender domain. */
function newsletterFrom(demo: DemoBackend, domain: string) {
  return demo["messages"].find((m) => m.unsubscribe && m.from.email.endsWith(`@${domain}`))!;
}

/** Runs a demo call to its end without waiting out its pretend latency. */
async function settle<T>(call: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return call;
}

describe("DemoBackend unsubscribe", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does the one click for the shop", async () => {
    const demo = new DemoBackend();
    const message = newsletterFrom(demo, "pixelparts.example");
    expect(await settle(demo.unsubscribe(message.id))).toEqual({ kind: "done" });
    expect(newsletterFrom(demo, "pixelparts.example")).toBeUndefined();
  });

  it("has the bakery refuse the one click, and takes the mail only when asked again", async () => {
    const demo = new DemoBackend();
    const message = newsletterFrom(demo, "kaffeekuchen.example");
    expect(await settle(demo.unsubscribe(message.id))).toEqual({
      kind: "oneClickFailed",
      reason: "kaffeekuchen.example answered 503.",
      fallback: "mail",
    });
    // Nothing was done yet.
    expect(newsletterFrom(demo, "kaffeekuchen.example")).toBeDefined();
    expect(await settle(demo.unsubscribe(message.id, { oneClick: false }))).toEqual({ kind: "done" });
    expect(newsletterFrom(demo, "kaffeekuchen.example")).toBeUndefined();
  });
});
