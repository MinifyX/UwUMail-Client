import type { Folder, Protocol } from "@/backend/types";

/**
 * What's wrong with a folder name, said before the engine says it (in English) after a round trip.
 * The engine checks the same again (crates/uwumail-core/src/folders.rs `clean_name`).
 */
export type FolderNameProblem =
  { kind: "empty" | "slash" | "control" | "tooLong" | "dots" | "taken" } | { kind: "character"; character: string };

/** The engine's limits: characters, and UTF-8 bytes (every server we know takes 255). */
const MAX_CHARACTERS = 200;
const MAX_BYTES = 255;

/** Control characters, including the Unicode line and paragraph separators. */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

export interface FolderNameRules {
  /** The character that separates folder levels on the server ("/" or "."), when known. */
  separator: string | null;
  /** IMAP also refuses its LIST wildcards `*` and `%`. */
  imap: boolean;
}

/**
 * The rules for a new name of a folder in this mailbox. JMAP (UwUMail) addresses folders by their
 * "/"-separated path; an IMAP server's separator shows in a nested folder's path.
 */
export function folderNameRules(protocol: Protocol, folders: readonly Folder[]): FolderNameRules {
  if (protocol === "jmap") return { separator: "/", imap: false };
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const folder of folders) {
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    if (parent && folder.path.length > parent.path.length + 1 && folder.path.startsWith(parent.path)) {
      return { separator: folder.path[parent.path.length]!, imap: true };
    }
  }
  return { separator: null, imap: true };
}

/** Checks a name, trimmed, against the folders it would sit next to (their names, any case). */
export function folderNameProblem(
  name: string,
  siblings: readonly string[],
  rules: FolderNameRules,
): FolderNameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return { kind: "empty" };
  if ([...trimmed].length > MAX_CHARACTERS || new TextEncoder().encode(trimmed).length > MAX_BYTES) {
    return { kind: "tooLong" };
  }
  if (CONTROL.test(trimmed)) return { kind: "control" };
  if (rules.separator && trimmed.includes(rules.separator)) {
    return rules.separator === "/" ? { kind: "slash" } : { kind: "character", character: rules.separator };
  }
  if (rules.imap) {
    const wildcard = [...trimmed].find((character) => character === "*" || character === "%");
    if (wildcard) return { kind: "character", character: wildcard };
  }
  if (trimmed === "." || trimmed === "..") return { kind: "dots" };
  const lower = trimmed.toLowerCase();
  if (siblings.some((sibling) => sibling.toLowerCase() === lower)) return { kind: "taken" };
  return null;
}
