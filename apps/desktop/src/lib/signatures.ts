import type { Signature } from "@/backend/types";

/** Marks the signature block in the composer, so switching replaces it. Removed before sending. */
export const SIGNATURE_ATTRIBUTE = "data-uwu-signature";

export type SignaturePlacement = "end" | "beforeQuote";

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
  block.innerHTML = signature.html;
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
