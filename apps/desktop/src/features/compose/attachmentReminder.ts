/**
 * The attachment reminder: before sending, the composer asks when the text speaks of an
 * attachment and none is there (setting `compose.attachmentReminder`).
 *
 * Only what the person wrote counts: the quoted mail of a reply or forward (blockquotes, the
 * forwarded part, lines starting with ">") and the signature are left out, so "see attached" in
 * someone else's mail or a footer never asks.
 */

import { splitDraft } from "@/features/assist/draftText";
import { htmlToPlainText } from "@/lib/safeHtml";
import { SIGNATURE_ATTRIBUTE } from "@/lib/signatures";

/**
 * German and English words for "attached": Anhang, Anhänge, angehängt, anhängen, anbei,
 * beigefügt, beiliegend, Anlage(n); attach, attached, attachment(s), enclosed. Whole words only, so
 * "Anhänger" or "attaché" stay out.
 */
const KEYWORDS =
  /(?<![\p{L}\p{N}])(?:anhang|anhangs|anhanges|anhänge|anhängen|angehängt\p{L}*|anbei|beigefügt\p{L}*|beiliegend\p{L}*|anlagen?|attach|attached|attaches|attaching|attachments?|enclosed)(?![\p{L}\p{N}])/iu;

/** The person's own text in a draft: no quote, no forwarded mail, no signature. */
export function ownWrittenText(html: string): string {
  const own = new DOMParser().parseFromString(`<body>${splitDraft(html).own}</body>`, "text/html").body;
  // Quotes and a signature inside the own part too (an answer written between quoted lines).
  for (const node of own.querySelectorAll(`blockquote, [${SIGNATURE_ATTRIBUTE}]`)) node.remove();
  return htmlToPlainText(own.innerHTML)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
}

/** Whether the person's own text speaks of an attachment. */
export function mentionsAttachment(html: string): boolean {
  return KEYWORDS.test(ownWrittenText(html));
}

/** Whether sending should ask first. */
export function needsAttachmentReminder(html: string, attachments: number, enabled: boolean): boolean {
  return enabled && attachments === 0 && mentionsAttachment(html);
}
