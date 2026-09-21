import type { Address, MailtoDraft } from "@/backend/types";

function addresses(value: string | null): Address[] {
  if (!value) return [];
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part.includes("@") && !/\s/.test(part))
    .map((email) => ({ email }));
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads a `mailto:` link into a draft, like the engine does (crates/uwumail-core/src/mailto.rs):
 * when a link in a mail is followed, and in the webmail when the server hands one over as `?mailto=…`.
 */
export function parseMailto(link: string): MailtoDraft | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "mailto:") return null;
  const params = url.searchParams;
  return {
    to: [...addresses(decode(url.pathname)), ...params.getAll("to").flatMap(addresses)],
    cc: params.getAll("cc").flatMap(addresses),
    bcc: params.getAll("bcc").flatMap(addresses),
    subject: params.get("subject") ?? "",
    body: (params.get("body") ?? "").replace(/\r\n/g, "\n"),
  };
}
