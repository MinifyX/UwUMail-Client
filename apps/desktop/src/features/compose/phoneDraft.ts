import type { SavedDraft } from "@/state/ui";

// Android may end UwUMail while a draft waits as a bar, so the phone keeps a
// copy until it's sent or thrown away. Attachments are left out: they can be
// too big for local storage.

const KEY = "uwumail.phoneDraft";

export function savePhoneDraft(draft: SavedDraft) {
  try {
    localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Storage full or unavailable: the draft just isn't kept.
  }
}

export function clearPhoneDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The kept draft, if it has anything worth bringing back. */
export function loadPhoneDraft(): SavedDraft | null {
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
