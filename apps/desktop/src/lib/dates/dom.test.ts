import { describe, expect, it } from "vitest";
import { collectText, markText, parseBody } from "./dom";
import { eventsInImageText, eventsInMail, isForward, markMail } from "./index";

const CONTEXT = { subject: "Newsletter", reference: "2026-09-29T10:00:00", locale: "de-DE" };

describe("collectText", () => {
  it("reads text like it renders: blocks on lines, whitespace collapsed", () => {
    const { text } = collectText(
      parseBody("<h1>Herbst\n   Sale</h1><p>vom   6. –\n 9. Okt</p><table><tr><td>Fr</td><td>16.10.</td></tr></table>"),
    );
    expect(text).toBe("Herbst Sale\nvom 6. – 9. Okt\nFr 16.10. \n");
  });

  it("leaves out what a reader never sees", () => {
    const { text } = collectText(
      parseBody(
        `<div style="display:none">Preheader 1.10.</div><span class="preheader">2.10.</span>` +
          `<div style="font-size:0;line-height:0">3.10.</div><div style="max-height:0;overflow:hidden">4.10.</div>` +
          `<div style="opacity:0">5.10.</div><div hidden>6.10.</div><div style="mso-hide:all">7.10.</div>` +
          `<style>p{color:red}</style><p>Sichtbar</p>`,
      ),
    );
    expect(text.trim()).toBe("Sichtbar");
  });

  it("reports quotes and signatures, except in a forward", () => {
    const html = `<p>Neu</p><blockquote type="cite"><p>Alt</p></blockquote><div class="gmail_signature">Sig</div>`;
    const reply = collectText(parseBody(html));
    expect(reply.excluded.map(([from, to]) => reply.text.slice(from, to).trim())).toEqual(["Alt", "Sig"]);
    const forward = collectText(parseBody(html), true);
    expect(forward.excluded.map(([from, to]) => forward.text.slice(from, to).trim())).toEqual(["Sig"]);
  });

  it("knows which text is a link", () => {
    const { pieces } = collectText(parseBody(`<p>am <a href="https://shop.example/">17.10.</a></p>`));
    expect(pieces.map((piece) => piece.linked)).toEqual([false, true]);
  });

  it("keeps pre text as it is", () => {
    const { text } = collectText(parseBody("<pre>a\n  b</pre>"));
    expect(text).toBe("a\n  b\n");
  });
});

describe("markText", () => {
  it("wraps a hit spread over several nodes, the first part focusable", () => {
    const body = parseBody("<p>Deals vom <b>6.</b> –\n  9. Okt!</p>");
    const collected = collectText(body);
    const from = collected.text.indexOf("6.");
    const to = collected.text.indexOf("Okt") + 3;
    markText(body, collected, [{ from, to, index: 0, label: "Termin" }]);
    const spans = [...body.querySelectorAll("[data-uwu-date]")];
    expect(spans.map((span) => span.textContent)).toEqual(["6.", " –\n  9. Okt"]);
    expect(spans[0]!.getAttribute("tabindex")).toBe("0");
    expect(spans[0]!.getAttribute("role")).toBe("button");
    expect(spans[0]!.getAttribute("aria-label")).toBe("Termin");
    expect(spans[1]!.hasAttribute("tabindex")).toBe(false);
    expect(body.textContent).toBe("Deals vom 6. –\n  9. Okt!");
  });

  it("wraps two hits in one text node", () => {
    const body = parseBody("<p>am 1.10. und am 2.10. offen</p>");
    const collected = collectText(body);
    const first = collected.text.indexOf("1.10.");
    const second = collected.text.indexOf("2.10.");
    markText(body, collected, [
      { from: first, to: first + 5, index: 0, label: "a" },
      { from: second, to: second + 5, index: 1, label: "b" },
    ]);
    expect(body.querySelector("p")!.innerHTML).toBe(
      'am <span class="uwu-date" data-uwu-date="0" tabindex="0" role="button" aria-haspopup="dialog" aria-label="a">1.10.</span> und am <span class="uwu-date" data-uwu-date="1" tabindex="0" role="button" aria-haspopup="dialog" aria-label="b">2.10.</span> offen',
    );
  });

  it("leaves links alone", () => {
    const body = parseBody(`<p>am <a href="https://shop.example/">17.10.</a></p>`);
    const collected = collectText(body);
    markText(body, collected, [{ from: 3, to: 9, index: 0, label: "x" }]);
    expect(body.querySelector("[data-uwu-date]")).toBeNull();
  });
});

describe("mail", () => {
  it("finds events in HTML, not in hidden text, quotes or the footer", () => {
    const html =
      `<div class="preheader" style="display:none">Nur bis 1.10.!</div>` +
      `<h2>Herbstfest</h2><p>Sa 17.10. ab 14 Uhr im Stadtpark</p>` +
      `<p>${"Mehr Text. ".repeat(30)}</p>` +
      `<blockquote><p>Letztes Jahr: 18.10. ab 14 Uhr</p></blockquote>` +
      `<p>Impressum: Verein e.V., Amtsgericht Musterstadt, Stand 01.10.2026</p>`;
    const events = eventsInMail(html, CONTEXT);
    expect(events.map((event) => [event.start, event.title, event.location])).toEqual([
      ["2026-10-17T14:00:00", "Herbstfest", "Stadtpark"],
    ]);
  });

  it("marks what it found in the same markup", () => {
    const html = "<p>Prime Day deals vom 6. – 9. Okt</p>";
    const [event] = eventsInMail(html, CONTEXT);
    const marked = markMail(html, CONTEXT.subject, [{ from: event!.from, to: event!.to, index: 0, label: "Termin" }]);
    expect(marked).toContain('data-uwu-date="0"');
    expect(parseBody(marked).querySelector("[data-uwu-date]")!.textContent).toBe("6. – 9. Okt");
  });

  it("drops look-alike marks the mail brings", () => {
    const html = '<p data-uwu-date="0" class="uwu-date">Klick</p><p>Prime Day deals vom 6. – 9. Okt</p>';
    const [event] = eventsInMail(html, CONTEXT);
    const marked = parseBody(
      markMail(html, CONTEXT.subject, [{ from: event!.from, to: event!.to, index: 0, label: "Termin" }]),
    );
    expect([...marked.querySelectorAll("[data-uwu-date]")].map((part) => part.textContent)).toEqual(["6. – 9. Okt"]);
  });

  it("returns the markup untouched without marks", () => {
    expect(markMail("<p>x</p>", "s", [])).toBe("<p>x</p>");
  });

  it("reads forwarded mails", () => {
    expect(isForward("WG: Einladung")).toBe(true);
    expect(isForward("Fwd: Invitation")).toBe(true);
    expect(isForward("Re: Einladung")).toBe(false);
    const html = `<p>Schau mal</p><blockquote type="cite"><p>Einladung: Lesung am 17.10. um 19 Uhr</p></blockquote>`;
    expect(eventsInMail(html, { ...CONTEXT, subject: "WG: Einladung" })).toHaveLength(1);
    expect(eventsInMail(html, { ...CONTEXT, subject: "Re: Einladung" })).toHaveLength(0);
  });

  it("finds events in text read from a picture", () => {
    const events = eventsInImageText("SOMMERFEST\nSa 17.10. 14-18 Uhr\nStadtpark", CONTEXT);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "image", start: "2026-10-17T14:00:00", end: "2026-10-17T18:00:00" });
  });
});
