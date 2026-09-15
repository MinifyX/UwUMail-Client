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

/** Marks the kept copy as safely in the Drafts folder, so it isn't brought back on its own. */
export function markLocalDraftSaved(draftKey: string) {
  const draft = loadLocalDraft();
  if (draft) saveLocalDraft({ ...draft, draftKey, savedToServer: true });
}

/** The kept draft, if it has anything worth bringing back. */
export function loadLocalDraft(): SavedDraft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as SavedDraft;
    const text = draft.html.replace(/<[^>]*>/g, "").trim();
    return draft.to.length + draft.cc.length + draft.bcc.length > 0 || draft.subject || text ? draft : null;
  } catch {
    return null;
  }
}
