import type { Signature } from "@/backend/types";
import { quotableHtml } from "./safeHtml";

/** Marks the signature block in the composer, so switching replaces it. Removed before sending. */
export const SIGNATURE_ATTRIBUTE = "data-uwu-signature";

export type SignaturePlacement = "end" | "beforeQuote";

/**
 * Signature HTML made safe to show or insert: the composer's own cleaner (no scripts, styles,
 * forms, remote content or `data-uwu-*` markers), and pictures only as embedded `data:image/…`
 * URLs. Signatures come from this device, a server's shared settings or a domain's signature,
 * which other clients write too, so they are never trusted (security-audit CS-8).
 */
export function cleanSignatureHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${quotableHtml(html, { foreign: true })}</body>`, "text/html");
  for (const image of doc.body.querySelectorAll("img")) {
    if (!/^data:image\/(png|jpeg|gif|webp);/i.test(image.getAttribute("src") ?? "")) image.remove();
  }
  return doc.body.innerHTML;
}

/** The signature an address uses by default for new mail or for replies and forwards. */
export function defaultSignature(signatures: Signature[], email: string, kind: "new" | "reply"): Signature | undefined {
  const own = signatures.filter((s) => s.email.toLowerCase() === email.toLowerCase());
  return own.find((s) => (kind === "new" ? s.forNew : s.forReplies));
}

/**
 * The composer body with `signature` in place of the current one (or without one for null).
 * A new signature goes at the end of new mail, and between the typing space and the quote of
 * replies and forwards.
 */
export function withSignature(html: string, signature: Signature | null, placement: SignaturePlacement): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const body = doc.body;
  const current = body.querySelector(`[${SIGNATURE_ATTRIBUTE}]`);
  if (!signature) {
    current?.remove();
    return body.innerHTML;
  }
  const block = doc.createElement("div");
  block.setAttribute(SIGNATURE_ATTRIBUTE, signature.id);
  // The composer writes the result straight into its editor, in the app's own page: stored or
  // synced signature HTML goes through the composer's cleaner first (security-audit CS-8).
  block.innerHTML = cleanSignatureHtml(signature.html);
  if (current) {
    current.replaceWith(block);
  } else if (placement === "beforeQuote" && body.firstElementChild) {
    body.firstElementChild.after(block);
  } else {
    if (!body.lastElementChild || body.textContent?.trim()) body.append(doc.createElement("p"));
    body.lastElementChild?.replaceChildren(doc.createElement("br"));
    body.append(block);
  }
  return body.innerHTML;
}

/** What goes out: the signature stays, its marker doesn't. */
export function withoutSignatureMarker(html: string): string {
  return html.replace(new RegExp(`\\s${SIGNATURE_ATTRIBUTE}="[^"]*"`, "g"), "");
}
