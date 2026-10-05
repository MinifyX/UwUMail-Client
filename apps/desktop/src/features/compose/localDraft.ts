import type { SavedDraft } from "@/state/ui";

// The composer keeps a copy of the open draft on this device, next to the server draft: the
// server copy can fail (offline) and Android may end UwUMail while a draft waits as a bar.
// Attachments are left out: they can be too big for local storage.

const KEY = "uwumail.phoneDraft";

export function saveLocalDraft(draft: SavedDraft) {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Storage full or unavailable: the draft just isn't kept.
  }
}

export function clearLocalDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Marks the kept copy as safely in the Drafts folder, so it isn't brought back on its own. With the
 * draft's message id, only that id stays on this device: addresses, subject and text (and the
 * quoted mail in them) are in the Drafts folder already and needn't wait in local storage. Without
 * one (the server didn't say where the draft went) the whole copy stays.
 */
export function markLocalDraftSaved(draftKey: string, messageId?: string) {
  const draft = loadLocalDraft();
  if (!draft) return;
  saveLocalDraft(
    messageId
      ? {
          mode: draft.mode,
          accountId: draft.accountId,
          to: [],
          cc: [],
          bcc: [],
          subject: "",
          html: "",
          draftKey,
          messageId,
          savedToServer: true,
        }
      : { ...draft, draftKey, savedToServer: true },
  );
}

/** The kept draft, if it has anything worth bringing back. */
export function loadLocalDraft(): SavedDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as SavedDraft;
    if (typeof draft.messageId === "string" && draft.messageId && draft.savedToServer === true) return draft;
    const text = draft.html.replace(/<[^>]*>/g, "").trim();
    return draft.to.length + draft.cc.length + draft.bcc.length > 0 || draft.subject || text ? draft : null;
  } catch {
    return null;
  }
}
