import { describe, expect, it } from "vitest";
import { detectEvents } from "./detect";
import { boilerplate } from "./structure";
import { eventsInMail } from "./index";

const REFERENCE = "2026-09-29T10:00:00";
const OPTIONS = { reference: REFERENCE, subject: "Hallo", locale: "de-DE" } as const;

/** Distinct dates, one after the other on one line, like inline HTML without block elements gives. */
function datesOnOneLine(size: number): string {
  const parts: string[] = [];
  let length = 0;
  for (let index = 0; length < size; index++) {
    const day = (index % 28) + 1;
    const month = ((index >> 5) % 12) + 1;
    const part = `Treffen am ${day}.${month}. um ${10 + (index % 10)}:00 Uhr im Café Linde, `;
    parts.push(part);
    length += part.length;
  }
  return parts.join("");
}

describe("date detection on hostile input", () => {
  it("stays fast on a 1 MB single line full of dates", () => {
    const text = datesOnOneLine(1_000_000);
    const started = performance.now();
    const events = detectEvents(text, { ...OPTIONS, excluded: boilerplate(text, false) });
    const took = performance.now() - started;
    expect(events.length).toBeGreaterThan(0);
    expect(took).toBeLessThan(2000);
  });

  it("stays fast on 100 KB of dates followed by 1 MB of padding on the same line", () => {
    const text = datesOnOneLine(100_000) + "x ".repeat(500_000);
    const started = performance.now();
    detectEvents(text, OPTIONS);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("stays fast for a whole mail body of one long paragraph", () => {
    const html = `<p>${datesOnOneLine(1_000_000)}</p>`;
    const started = performance.now();
    eventsInMail(html, { subject: "Hallo", reference: REFERENCE, locale: "de-DE" });
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
