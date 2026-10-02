import { describe, expect, it } from "vitest";
import type { AssistEvent } from "@/backend/types";
import { detectEvents } from "./detect";
import { fromAssist, mergeEvents } from "./merge";

const REFERENCE = "2026-09-29T10:00:00";
const context = { reference: REFERENCE, subject: "Hallo", locale: "de-DE" };

function assist(patch: Partial<AssistEvent>): AssistEvent {
  return {
    title: "Lesung",
    start: "2026-10-16T19:30:00",
    end: "2026-10-16T21:00:00",
    allDay: false,
    timeZone: null,
    location: null,
    description: null,
    url: null,
    participants: [],
    confidence: 0.9,
    quote: "Lesung am Freitag",
    ...patch,
  };
}

describe("fromAssist", () => {
  it("takes wall times with or without seconds", () => {
    expect(fromAssist(assist({ start: "2026-10-16T19:30", end: "2026-10-16T21:00" }), REFERENCE)).toMatchObject({
      start: "2026-10-16T19:30:00",
      end: "2026-10-16T21:00:00",
      source: "ai",
      from: -1,
      endKnown: true,
      past: false,
    });
  });

  it("drops what isn't a time or ends before it starts", () => {
    expect(fromAssist(assist({ start: "Freitag" }), REFERENCE)).toBeNull();
    expect(fromAssist(assist({ end: "2026-10-16T18:00:00" }), REFERENCE)).toBeNull();
  });

  it("keeps only https links and bounds what it says, by characters", () => {
    expect(fromAssist(assist({ url: "https://shop.example/tickets" }), REFERENCE)?.url).toBe(
      "https://shop.example/tickets",
    );
    for (const url of ["javascript:alert(1)", "http://shop.example/", "data:text/html,x", "nonsense", ""]) {
      expect(fromAssist(assist({ url }), REFERENCE)?.url).toBeNull();
    }
    const long = fromAssist(assist({ title: "🎉".repeat(600), description: "é".repeat(3000) }), REFERENCE)!;
    expect(Array.from(long.title)).toHaveLength(500);
    expect(long.title.endsWith("🎉")).toBe(true);
    expect(Array.from(long.description!)).toHaveLength(2000);
  });

  it("knows an all-day event that ended before the mail", () => {
    const event = fromAssist(
      assist({ allDay: true, start: "2026-09-20T00:00:00", end: "2026-09-21T00:00:00" }),
      REFERENCE,
    );
    expect(event?.past).toBe(true);
  });
});

describe("mergeEvents", () => {
  const text = detectEvents("Lesung am Freitag, 16.10. um 19:30 Uhr im Café Lindenblüte.", context);
  const image = detectEvents("HERBSTFEST\nSa 17.10. · 14–18 Uhr", { ...context, source: "image" });

  it("lets the assistant refine a text hit, which keeps its place in the text", () => {
    const ai = [
      fromAssist(assist({ title: "Lesung mit Leni", location: "Café Lindenblüte, Musterstadt" }), REFERENCE)!,
    ];
    const [event, ...rest] = mergeEvents(text, [], ai);
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      from: text[0]!.from,
      source: "text",
      refined: true,
      title: "Lesung mit Leni",
      end: "2026-10-16T21:00:00",
      endKnown: true,
      location: "Café Lindenblüte, Musterstadt",
    });
  });

  it("adds what only the picture or only the assistant found, in the order it happens", () => {
    const ai = [
      fromAssist(
        assist({ title: "Abgabe", start: "2026-10-01T00:00:00", end: "2026-10-02T00:00:00", allDay: true }),
        REFERENCE,
      )!,
    ];
    const merged = mergeEvents(text, image, ai);
    expect(merged.map((event) => [event.source, event.start])).toEqual([
      ["ai", "2026-10-01T00:00:00"],
      ["text", "2026-10-16T19:30:00"],
      ["image", "2026-10-17T14:00:00"],
    ]);
  });

  it("shows a picture hit the text already has only once", () => {
    const again = detectEvents("Lesung Fr 16.10. 19:30", { ...context, source: "image" });
    expect(mergeEvents(text, again, [])).toHaveLength(1);
  });

  it("matches a day-only hit to a timed reading of the same day", () => {
    const day = detectEvents("Sommerfest am 16.10.2026", context);
    const merged = mergeEvents(day, [], [fromAssist(assist({ title: "Sommerfest" }), REFERENCE)!]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ allDay: false, start: "2026-10-16T19:30:00", refined: true });
  });

  describe("times beat a bare day, whichever side found them", () => {
    const range = detectEvents("Flohmarkt am Samstag 03.10.26, zwischen 10:00 und 12:00 im Hof", context);

    it("keeps the text's time range when the assistant only saw the day", () => {
      const ai = fromAssist(
        assist({ title: "Flohmarkt", start: "2026-10-03T00:00:00", end: "2026-10-04T00:00:00", allDay: true }),
        REFERENCE,
      )!;
      const [event, ...rest] = mergeEvents(range, [], [ai]);
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({
        start: "2026-10-03T10:00:00",
        end: "2026-10-03T12:00:00",
        allDay: false,
        endKnown: true,
        title: "Flohmarkt",
        refined: true,
      });
    });

    it("keeps an end the text read when the assistant only assumed an hour", () => {
      const ai = fromAssist(assist({ start: "2026-10-03T10:00:00", end: "2026-10-03T11:00:00" }), REFERENCE)!;
      expect(mergeEvents(range, [], [ai])[0]).toMatchObject({ end: "2026-10-03T12:00:00", allDay: false });
    });

    it("takes the assistant's own end when it read a different one", () => {
      const ai = fromAssist(assist({ start: "2026-10-03T10:00:00", end: "2026-10-03T12:30:00" }), REFERENCE)!;
      expect(mergeEvents(range, [], [ai])[0]).toMatchObject({ end: "2026-10-03T12:30:00" });
    });

    it("keeps several days the text read over the assistant's single one", () => {
      const days = detectEvents("Messe vom 12. bis 15. Okt. 2026", context);
      const ai = fromAssist(
        assist({ title: "Messe", start: "2026-10-12T00:00:00", end: "2026-10-13T00:00:00", allDay: true }),
        REFERENCE,
      )!;
      expect(mergeEvents(days, [], [ai])[0]).toMatchObject({
        start: "2026-10-12T00:00:00",
        end: "2026-10-16T00:00:00",
        allDay: true,
        title: "Messe",
      });
    });

    it("lets a picture's time fill in a day-only text hit", () => {
      const day = detectEvents("Herbstfest am 17.10.2026", context);
      const [event, ...rest] = mergeEvents(day, image, []);
      expect(rest).toHaveLength(0);
      expect(event).toMatchObject({
        start: "2026-10-17T14:00:00",
        end: "2026-10-17T18:00:00",
        allDay: false,
        source: "text",
      });
    });
  });
});
