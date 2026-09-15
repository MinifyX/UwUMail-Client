import { describe, expect, it } from "vitest";
import type { Account, Identity, Message } from "@/backend/types";
import { initialDraft, replyFrom } from "./draft";

const account: Account = {
  id: "acc",
  name: "uwumail.dev",
  email: "mini@uwumail.dev",
  displayName: "Mini",
  color: "pink",
  auth: "password",
  status: { state: "idle" },
  protocol: "imap",
  protocols: ["imap"],
};

const identities: Identity[] = [
  { id: "acc", accountId: "acc", email: "mini@uwumail.dev", name: "Mini", primary: true, fromServer: false },
  { id: "i1", accountId: "acc", email: "hallo@uwumail.dev", name: "Studio", primary: false, fromServer: false },
  { id: "i2", accountId: "other", email: "shop@elsewhere.example", name: "", primary: false, fromServer: true },
];

function message(to: string[], cc: string[] = []): Message {
  return {
    id: "m1",
    threadId: "t1",
    accountId: "acc",
    folderId: "acc:inbox",
    from: { name: "Leni", email: "leni@wanders.example" },
    to: to.map((email) => ({ email })),
    cc: cc.map((email) => ({ email })),
    replyTo: [],
    subject: "Hallo",
    date: "2026-09-15T10:00:00Z",
    flags: { seen: true, flagged: false, answered: false, draft: false },
    snippet: "",
    bodyHtml: null,
    bodyText: "Hi",
    hasRemoteContent: false,
    attachments: [],
  };
}

const t = (key: string) => key;

describe("replies", () => {
  it("come from the alias the mail was sent to", () => {
    expect(replyFrom(message(["HALLO@uwumail.dev"]), identities)).toBe("hallo@uwumail.dev");
    expect(replyFrom(message(["leni@wanders.example"], ["hallo@uwumail.dev"]), identities)).toBe("hallo@uwumail.dev");
  });

  it("use the mailbox's own address otherwise", () => {
    expect(replyFrom(message(["mini@uwumail.dev"]), identities)).toBe("");
    // An alias of another mailbox doesn't count.
    expect(replyFrom(message(["shop@elsewhere.example"]), identities)).toBe("");
  });

  it("leave all my addresses out of reply all", () => {
    const source = message(["hallo@uwumail.dev", "fee@friends.example"], ["mini@uwumail.dev"]);
    const draft = initialDraft({ key: 1, mode: "replyAll", source }, [account], identities, t, "de");
    expect([...draft.to, ...draft.cc].map((a) => a.email)).toEqual(["leni@wanders.example", "fee@friends.example"]);
    expect(draft.fromEmail).toBeNull();
  });
});
