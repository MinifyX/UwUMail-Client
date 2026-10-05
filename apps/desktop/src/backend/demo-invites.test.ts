import { describe, expect, it } from "vitest";
import { DemoBackend } from "./demo";
import type { Message } from "./types";

/** The demo's mail with an .ics part of this name. */
function mailWith(demo: DemoBackend, name: string): Message {
  const messages = (demo as unknown as { messages: Message[] }).messages;
  return messages.find((message) => message.attachments.some((attachment) => attachment.filename === name))!;
}

describe("the demo's calendar mail", () => {
  it("answers Emma's invitation and doesn't believe the look-alike cancellation", async () => {
    const demo = new DemoBackend();
    const invite = mailWith(demo, "logo-review.ics");
    const shown = await demo.mailInvitation(invite.id);
    expect(shown).toMatchObject({ kind: "invitation", verified: true, canAnswer: true, status: "needs-action" });
    await demo.respondToInvitation(invite.id, "accepted", "Bis dann");
    expect((await demo.mailInvitation(invite.id))?.status).toBe("accepted");

    const forged = mailWith(demo, "logo-review-cancel.ics");
    expect(await demo.mailInvitation(forged.id)).toMatchObject({ verified: false, canRemove: false, cancelled: false });
    await expect(demo.removeCancelledEvent(forged.id)).rejects.toThrow();

    const reply = mailWith(demo, "game-night-reply.ics");
    expect(await demo.mailInvitation(reply.id)).toMatchObject({ kind: "reply", status: "accepted", verified: true });
  });
});
