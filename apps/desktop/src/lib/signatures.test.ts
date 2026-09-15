import { describe, expect, it } from "vitest";
import type { Signature } from "@/backend/types";
import { defaultSignature, withSignature, withoutSignatureMarker } from "./signatures";

const signature = (id: string, email: string, forNew: boolean, forReplies: boolean): Signature => ({
  id,
  email,
  name: id,
  html: `<p>Liebe Grüße, <b>${id}</b></p>`,
  forNew,
  forReplies,
});

const all = [
  signature("lang", "mini@uwumail.dev", true, false),
  signature("kurz", "mini@uwumail.dev", false, true),
  signature("studio", "hallo@uwumail.dev", true, true),
];

describe("signatures", () => {
  it("picks the default for new mail or replies of an address", () => {
    expect(defaultSignature(all, "MINI@uwumail.dev", "new")?.id).toBe("lang");
    expect(defaultSignature(all, "mini@uwumail.dev", "reply")?.id).toBe("kurz");
    expect(defaultSignature(all, "leni@wanders.example", "new")).toBeUndefined();
  });

  it("goes at the end of new mail with room to type above", () => {
    const html = withSignature("", all[0]!, "end");
    expect(html).toBe('<p><br></p><div data-uwu-signature="lang"><p>Liebe Grüße, <b>lang</b></p></div>');
  });

  it("sits above the quote of a reply and can be swapped or removed", () => {
    const reply = "<p><br></p><p>Am Montag schrieb Leni:</p><blockquote>Hi</blockquote>";
    const signed = withSignature(reply, all[1]!, "beforeQuote");
    expect(signed).toBe(
      '<p><br></p><div data-uwu-signature="kurz"><p>Liebe Grüße, <b>kurz</b></p></div><p>Am Montag schrieb Leni:</p><blockquote>Hi</blockquote>',
    );
    const swapped = withSignature(signed, all[2]!, "beforeQuote");
    expect(swapped).toContain('data-uwu-signature="studio"');
    expect(swapped).not.toContain("kurz");
    expect(withSignature(swapped, null, "beforeQuote")).toBe(reply);
  });

  it("drops the marker before sending", () => {
    expect(withoutSignatureMarker('<div data-uwu-signature="lang"><p>Hi</p></div>')).toBe("<div><p>Hi</p></div>");
  });
});
