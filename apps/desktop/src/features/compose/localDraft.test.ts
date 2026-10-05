import { beforeEach, describe, expect, it, vi } from "vitest";
import { BackendError } from "@/backend/backend";
import type { DraftContent } from "@/backend/types";
import { useUi } from "@/state/ui";
import { loadLocalDraft, markLocalDraftSaved, saveLocalDraft } from "./localDraft";
import { reopenSavedDraft } from "./openDraft";

const KEY = "uwumail.phoneDraft";

const fake = { openDraft: vi.fn<(messageId: string) => Promise<DraftContent>>() };

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

function writeDraft() {
  saveLocalDraft({
    mode: "reply",
    accountId: "a",
    to: [{ email: "friend@example.org" }],
    cc: [],
    bcc: [{ email: "secret@example.org" }],
    subject: "Private",
    html: "<p>Only for me</p><blockquote>The quoted mail</blockquote>",
    inReplyTo: "m1",
    savedToServer: false,
  });
}

beforeEach(() => {
  localStorage.clear();
  fake.openDraft.mockReset();
  useUi.getState().closeCompose();
});

describe("the draft kept on this device", () => {
  it("keeps only the draft's id once it is in the Drafts folder", () => {
    writeDraft();
    markLocalDraftSaved("key@example.org", "m7");
    const raw = localStorage.getItem(KEY)!;
    expect(raw).not.toContain("friend@example.org");
    expect(raw).not.toContain("secret@example.org");
    expect(raw).not.toContain("Private");
    expect(raw).not.toContain("quoted mail");
    expect(loadLocalDraft()).toMatchObject({ messageId: "m7", draftKey: "key@example.org", savedToServer: true });
  });

  it("keeps the whole copy when the account names no id", () => {
    writeDraft();
    markLocalDraftSaved("key@example.org");
    expect(loadLocalDraft()).toMatchObject({ subject: "Private", savedToServer: true, draftKey: "key@example.org" });
  });

  it("keeps the whole copy while it isn't saved", () => {
    writeDraft();
    expect(loadLocalDraft()).toMatchObject({ subject: "Private", savedToServer: false });
  });

  it("brings back nothing for an empty copy", () => {
    saveLocalDraft({ mode: "new", accountId: "a", to: [], cc: [], bcc: [], subject: "", html: "<p><br></p>" });
    expect(loadLocalDraft()).toBeNull();
  });
});

describe("a draft kept as its id", () => {
  it("opens again from the account, as a bar", async () => {
    fake.openDraft.mockResolvedValue({
      accountId: "a",
      fromEmail: null,
      draftKey: "key@example.org",
      to: [{ email: "friend@example.org" }],
      cc: [],
      bcc: [],
      subject: "Private",
      html: "<p>Only for me</p>",
      inReplyTo: null,
      attachments: [],
    });
    await reopenSavedDraft("m7");
    expect(fake.openDraft).toHaveBeenCalledWith("m7");
    const ui = useUi.getState();
    expect(ui.compose?.restore).toMatchObject({ subject: "Private", draftKey: "key@example.org", savedToServer: true });
    expect(ui.composeMinimized).toBe(true);
  });

  it("is forgotten when the draft is gone", async () => {
    writeDraft();
    markLocalDraftSaved("key@example.org", "m7");
    fake.openDraft.mockRejectedValue(new BackendError("not_found", "This draft no longer exists."));
    await reopenSavedDraft("m7");
    expect(loadLocalDraft()).toBeNull();
    expect(useUi.getState().compose).toBeNull();
  });

  it("stays for next time when the account can't be reached", async () => {
    writeDraft();
    markLocalDraftSaved("key@example.org", "m7");
    fake.openDraft.mockRejectedValue(new BackendError("connection_failed", "Offline"));
    await reopenSavedDraft("m7");
    expect(loadLocalDraft()).toMatchObject({ messageId: "m7" });
  });
});
