import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendEvent, OutgoingMessage } from "./types";
import { DemoBackend } from "./demo";

const HOUR = 3_600_000;

function message(accountId: string, subject: string): OutgoingMessage {
  return {
    accountId,
    to: [{ name: "Kim", email: "kim@uwumail.example" }],
    cc: [],
    bcc: [],
    subject,
    html: "<p>Hi</p>",
    text: "Hi",
    attachments: [],
  };
}

describe("DemoBackend send later", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 5, 9, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("holds mail of the JMAP mailbox on the server and the others on this device", async () => {
    const demo = new DemoBackend();
    expect(await demo.sendLaterInfo("acc-private")).toEqual({ kind: "server", maxDelaySeconds: 30 * 86_400 });
    expect((await demo.sendLaterInfo("acc-studio")).kind).toBe("local");
  });

  it("schedules, lists, moves and sends at the time", async () => {
    const demo = new DemoBackend();
    const events: BackendEvent["type"][] = [];
    demo.subscribe((event) => events.push(event.type));
    const later = new Date(Date.now() + 2 * HOUR).toISOString();
    const pending = demo.sendLater(message("acc-studio", "Angebot"), later);
    await vi.advanceTimersByTimeAsync(500);
    const receipt = await pending;
    expect(receipt.kind).toBe("local");
    expect(events).toContain("scheduled:changed");

    const listing = demo.scheduledSends();
    await vi.advanceTimersByTimeAsync(200);
    const list = await listing;
    expect(list).toMatchObject([{ id: receipt.id, kind: "local", subject: "Angebot", accountId: "acc-studio" }]);

    await demo.rescheduleSend(list[0]!, new Date(Date.now() + 5 * HOUR).toISOString());
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(events).not.toContain("send:done");
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(events).toContain("send:done");
  });

  it("refuses times too soon or beyond what the mailbox holds", async () => {
    const demo = new DemoBackend();
    const soon = new Date(Date.now() + 10_000).toISOString();
    await expect(demo.sendLater(message("acc-studio", "x"), soon)).rejects.toThrow();
    const far = new Date(Date.now() + 40 * 86_400_000).toISOString();
    await expect(demo.sendLater(message("acc-private", "x"), far)).rejects.toThrow();
  });

  it("stops into Drafts and edits back into the composer", async () => {
    const demo = new DemoBackend();
    const at = new Date(Date.now() + 2 * HOUR).toISOString();
    const first = demo.sendLater(message("acc-private", "Eins"), at);
    const second = demo.sendLater(message("acc-private", "Zwei"), at);
    await vi.advanceTimersByTimeAsync(500);
    const [one, two] = await Promise.all([first, second]);
    const ref = (id: string) => ({ id, accountId: "acc-private", kind: "server" as const });

    const stopping = demo.stopScheduled(ref(one.id));
    await vi.advanceTimersByTimeAsync(500);
    await stopping;
    expect((await demo.editScheduled(ref(two.id))).subject).toBe("Zwei");
    await expect(demo.sendScheduledNow(ref(two.id))).rejects.toThrow();
    const listing = demo.scheduledSends();
    await vi.advanceTimersByTimeAsync(200);
    expect(await listing).toEqual([]);
  });
});
