import "@/test/dom";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "@/backend/types";
import { eventsInMail } from "@/lib/dates";
import { buildDocument, readableBody } from "../mail/MessageBody";
import { watchDates } from "./frameDates";

function message(patch: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "t1",
    accountId: "a1",
    folderId: "f1",
    from: { email: "news@shop.example" },
    to: [],
    cc: [],
    replyTo: [],
    subject: "Lesung",
    date: "2026-09-29T10:00:00Z",
    flags: { seen: false, flagged: false, answered: false, draft: false },
    snippet: "",
    bodyHtml: null,
    bodyText: null,
    hasRemoteContent: false,
    attachments: [],
    ...patch,
  };
}

const context = { subject: "Lesung", reference: "2026-09-29T10:00:00", locale: "de-DE" };
const marksOf = (mail: Message) =>
  eventsInMail(readableBody(mail), context).map((event, index) => ({
    from: event.from,
    to: event.to,
    index,
    label: "Termin",
  }));
const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("found dates in the reader's document", () => {
  it("wraps what the finder read in the very same markup, links and pictures intact", () => {
    const mail = message({
      bodyHtml:
        '<p>Am <b>Freitag</b>, 16.10. um 19:30 Uhr <a href="https://shop.example/a?d=16.10.">liest Leni</a>.</p><img src="cid:poster">',
    });
    const marks = marksOf(mail);
    expect(marks).toHaveLength(1);
    const doc = parse(buildDocument(mail, false, "light", new Map(), null, marks));
    const parts = [...doc.querySelectorAll("[data-uwu-date]")];
    expect(parts.map((part) => part.textContent).join("")).toBe("Freitag, 16.10. um 19:30 Uhr");
    expect(parts[0]!.getAttribute("role")).toBe("button");
    expect(parts[0]!.getAttribute("tabindex")).toBe("0");
    expect(doc.querySelector("a")!.getAttribute("href")).toBe("https://shop.example/a?d=16.10.");
    expect(doc.querySelector("style")!.textContent).toContain(".uwu-date");
    expect(doc.querySelector("script")).toBeNull();
  });

  it("marks plain text after its links were made", () => {
    const mail = message({
      bodyText: "Lesung am 16.10. um 19 Uhr, Karten: https://tickets.example/16.10.2026",
    });
    const doc = parse(buildDocument(mail, false, "light", new Map(), null, marksOf(mail)));
    expect(doc.querySelector("[data-uwu-date]")!.textContent).toBe("16.10. um 19 Uhr");
    expect(doc.querySelector("a")!.textContent).toBe("https://tickets.example/16.10.2026");
  });

  it("drops the marks a mail brings itself and never lets scripts in", () => {
    const mail = message({
      bodyHtml:
        '<p data-uwu-date="0" class="uwu-date" onclick="alert(1)">Klick</p><script>alert(1)</script><p>Lesung am 16.10. um 19 Uhr</p>',
    });
    const doc = parse(buildDocument(mail, false, "light", new Map(), null, marksOf(mail)));
    expect([...doc.querySelectorAll("[data-uwu-date]")].map((part) => part.textContent)).toEqual(["16.10. um 19 Uhr"]);
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("[onclick]")).toBeNull();
  });

  it("leaves the document as it was without marks", () => {
    const mail = message({ bodyHtml: "<p>Am 16.10. um 19 Uhr</p>" });
    expect(buildDocument(mail, false, "light", new Map(), null, [])).toBe(buildDocument(mail, false, "light"));
    expect(buildDocument(mail, false, "light")).not.toContain("uwu-date");
  });
});

describe("watchDates", () => {
  function setup() {
    // A document with a selection, as the frame's is: jsdom only gives the page's own one.
    const doc = document;
    doc.body.innerHTML = '<p>Am <span class="uwu-date" data-uwu-date="3" tabindex="0">16.10.</span> hier</p>';
    const frame = document.createElement("iframe");
    const report = vi.fn();
    watchDates(frame, doc, report);
    return { doc, report, mark: doc.querySelector<HTMLElement>("[data-uwu-date]")! };
  }

  it("reports a click on a date with its index, and one elsewhere as null", () => {
    const { doc, report, mark } = setup();
    mark.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(report).toHaveBeenLastCalledWith(3, expect.objectContaining({ left: expect.any(Number) }));
    doc.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(report).toHaveBeenLastCalledWith(null, expect.any(Object));
  });

  it("opens a date with Enter or Space and keeps those keys from the reader", () => {
    const { report, mark } = setup();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    mark.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    mark.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    expect(report).toHaveBeenCalledTimes(2);
    mark.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("opens a date once for a held key (webmail W-40)", () => {
    const { report, mark } = setup();
    const held = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    mark.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    expect(report).not.toHaveBeenCalled();
  });
});
