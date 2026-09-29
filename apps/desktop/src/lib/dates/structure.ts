/**
 * The parts of a mail's text that are not the mail itself: quoted replies, the header block of a
 * forwarded or replied-to mail, the signature and the legal footer. Dates there are history or
 * boilerplate, not appointments.
 */

export type Range = [number, number];

const QUOTE_LINE = /^\s*>/;
const REPLY_HEADER =
  /^\s*(am|on|le|op|el|il)\s.{0,200}(schrieb|wrote|a écrit|schreef|escribió|ha scritto)[^\n]{0,200}:?\s*$/iu;
const ORIGINAL =
  /^\s*-{2,}\s*(original message|ursprüngliche nachricht|original-nachricht|originalnachricht|message d'origine)\s*-{2,}\s*$/iu;
const FORWARD_MARKER =
  /^\s*(-{2,}\s*(forwarded message|weitergeleitete nachricht|nachricht weitergeleitet)\s*-{2,}|begin forwarded message:|anfang der weitergeleiteten (nachricht|e-mail):)\s*$/iu;
const HEADER_LINE =
  /^\s*\*?(von|from|gesendet|sent|datum|date|an|to|cc|bcc|betreff|subject|antwort an|reply-to)\s*:\*?\s/iu;
const FROM_LINE = /^\s*\*?(von|from)\s*:\*?\s/iu;
const SENT_LINE = /^\s*\*?(gesendet|sent|datum|date)\s*:\*?\s/iu;
const SIGNATURE = /^--\s?$/;
const CLOSING =
  /^\s*(mit freundlichen grüßen|mit freundlichem gruß|freundliche grüße|viele grüße|liebe grüße|beste grüße|herzliche grüße|schöne grüße|lg|vg|mfg|best regards|kind regards|warm regards|regards|best wishes|all the best|cheers|sincerely|yours sincerely|yours truly)[,!.]?\s*$/iu;
const FOOTER =
  /(impressum|handelsregister|registergericht|amtsgericht|hrb\s?\d|hra\s?\d|ust-?id|umsatzsteuer-?id|geschäftsführer|geschäftsführung|vorstand:|aufsichtsrat|sitz der gesellschaft|registered office|company (no|number|registration)|registered in|vat (no|number|reg)|alle rechte vorbehalten|all rights reserved|©|\(c\)\s?\d{4}|unsubscribe|abmelden|abbestellen|austragen|you are receiving|you received this|sie erhalten diese|du erhältst diese|diese e-mail wurde|this email was sent|this e-mail was sent|datenschutzerklärung|privacy policy)/iu;

interface Line {
  start: number;
  end: number;
  text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const part of text.split("\n")) {
    lines.push({ start, end: start + part.length, text: part });
    start += part.length + 1;
  }
  return lines;
}

/**
 * Ranges of `text` to leave alone. `forward`: the mail forwards another one, whose content is the
 * point; only its header lines go.
 */
export function boilerplate(text: string, forward: boolean): Range[] {
  const ranges: Range[] = [];
  const lines = linesOf(text);
  const toEnd = (line: Line) => ranges.push([line.start, text.length]);
  // A closing line or a footer only counts in the lower part of the mail.
  const footerFrom = text.length * 0.5;
  const signatureFrom = text.length * 0.4;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (QUOTE_LINE.test(line.text)) {
      ranges.push([line.start, line.end]);
      continue;
    }
    if (FORWARD_MARKER.test(line.text)) {
      // The forwarded mail's header lines, then its content.
      let next = index + 1;
      while (next < lines.length && (HEADER_LINE.test(lines[next]!.text) || lines[next]!.text.trim() === "")) next++;
      ranges.push([line.start, lines[next - 1]!.end]);
      index = next - 1;
      continue;
    }
    const outlookHeader =
      FROM_LINE.test(line.text) && lines.slice(index + 1, index + 5).some((other) => SENT_LINE.test(other.text));
    if (ORIGINAL.test(line.text) || outlookHeader || REPLY_HEADER.test(line.text)) {
      if (!forward) {
        toEnd(line);
        break;
      }
      let next = index + 1;
      while (next < lines.length && (HEADER_LINE.test(lines[next]!.text) || lines[next]!.text.trim() === "")) next++;
      ranges.push([line.start, lines[next - 1]!.end]);
      index = next - 1;
      continue;
    }
    if (SIGNATURE.test(line.text) && !forward) {
      toEnd(line);
      break;
    }
    if (line.start >= signatureFrom && CLOSING.test(line.text) && !forward) {
      toEnd(line);
      break;
    }
    if (line.start >= footerFrom && FOOTER.test(line.text)) {
      toEnd(line);
      break;
    }
  }
  return ranges;
}
