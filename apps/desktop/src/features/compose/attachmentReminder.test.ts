import { describe, expect, it } from "vitest";
import { mentionsAttachment, needsAttachmentReminder } from "./attachmentReminder";

describe("attachment reminder", () => {
  it("finds German and English words for attached", () => {
    for (const text of [
      "Die Rechnung findest du im Anhang.",
      "Anbei das Protokoll",
      "Ich habe die Datei angehängt",
      "Siehe Anlage",
      "Please find attached the report",
      "The attachment is the summary",
      "Enclosed you'll find the plan",
      "I'll ATTACH it",
    ]) {
      expect(mentionsAttachment(`<p>${text}</p>`), text).toBe(true);
    }
  });

  it("leaves out look-alikes", () => {
    for (const text of ["Ein Anhänger für das Fahrrad", "The attaché arrived", "Anlagenbau ist spannend"]) {
      expect(mentionsAttachment(`<p>${text}</p>`), text).toBe(false);
    }
  });

  it("ignores the quote, the forwarded mail and the signature", () => {
    const reply =
      '<p>Danke!</p><div data-uwu-signature=""><p>Mini – Rechnungen bitte als Anhang</p></div>' +
      "<p>Am 1. Oktober schrieb Leni:</p><blockquote><p>Anbei die Datei</p></blockquote>";
    expect(mentionsAttachment(reply)).toBe(false);
    const forward = "<p>FYI</p><p>---------- Forwarded message ----------</p><p>See attached.</p>";
    expect(mentionsAttachment(forward)).toBe(false);
    expect(mentionsAttachment("<p>&gt; Anbei die Datei<br>Gern!</p>")).toBe(false);
    expect(mentionsAttachment("<p>Hier die Antwort</p><blockquote>attached</blockquote><p>anbei</p>")).toBe(false);
  });

  it("asks only when on and nothing is attached", () => {
    const html = "<p>Anbei die Folien</p>";
    expect(needsAttachmentReminder(html, 0, true)).toBe(true);
    expect(needsAttachmentReminder(html, 1, true)).toBe(false);
    expect(needsAttachmentReminder(html, 0, false)).toBe(false);
    expect(needsAttachmentReminder("<p>Hallo</p>", 0, true)).toBe(false);
  });
});
