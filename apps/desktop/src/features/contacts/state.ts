import { create } from "zustand";
import type { ContactRecord } from "@/backend/types";

/** What a new contact starts with, e.g. the sender of a mail or a vCard someone sent. */
export interface ContactDraft {
  given?: string;
  surname?: string;
  organization?: string;
  title?: string;
  emails?: string[];
  phones?: string[];
  note?: string;
}

/** The editor: a contact to change, or a new one with what is already known. */
export interface ContactEditorRequest {
  contact: ContactRecord | null;
  draft?: ContactDraft;
}

interface ContactsUiState {
  /** The address book on screen; null shows all of them. */
  bookId: string | null;
  search: string;
  selectedId: string | null;
  editor: ContactEditorRequest | null;
  /** The contact waiting for "really delete?". */
  deleting: ContactRecord | null;
  setBook: (bookId: string | null) => void;
  setSearch: (search: string) => void;
  select: (contactId: string | null) => void;
  openEditor: (request: ContactEditorRequest) => void;
  closeEditor: () => void;
  askDelete: (contact: ContactRecord | null) => void;
}

export const useContactsUi = create<ContactsUiState>((set) => ({
  bookId: null,
  search: "",
  selectedId: null,
  editor: null,
  deleting: null,
  setBook: (bookId) => set({ bookId, selectedId: null }),
  setSearch: (search) => set({ search }),
  select: (selectedId) => set({ selectedId }),
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),
  askDelete: (deleting) => set({ deleting }),
}));

/** A new contact, with what is known already. */
export function startNewContact(draft?: ContactDraft) {
  useContactsUi.getState().openEditor({ contact: null, draft });
}
