import { describe, expect, it } from "vitest";
import { detectEvents, guessLanguage, slashOrderFor, subjectTitle, type DetectOptions } from "./detect";
import { boilerplate } from "./structure";

const REFERENCE = "2026-09-29T10:00:00";

function detect(text: string, options: Partial<DetectOptions> = {}) {
  return detectEvents(text, { reference: REFERENCE, subject: "Hallo", locale: "de-DE", ...options });
}

function only(text: string, options: Partial<DetectOptions> = {}) {
  const events = detect(text, options);
  expect(events, text).toHaveLength(1);
  return events[0]!;
}

describe("detectEvents", () => {
  it("turns a range into an all-day event with an exclusive end", () => {
    const event = only("Prime Day deals vom 6. – 9. Okt");
    expect(event).toMatchObject({
      start: "2026-10-06T00:00:00",
      end: "2026-10-10T00:00:00",
      allDay: true,
      endKnown: true,
      title: "Prime Day deals",
      text: "6. – 9. Okt",
      past: false,
    });
  });

  it("gives a time without an end one hour", () => {
    const event = only("Konzert am Freitag, 16.10. um 19:30 Uhr im Café Lindenblüte.");
    expect(event).toMatchObject({
      start: "2026-10-16T19:30:00",
      end: "2026-10-16T20:30:00",
      allDay: false,
      endKnown: false,
      title: "Konzert",
      location: "Café Lindenblüte",
    });
  });

  it("goes past midnight when the end comes before the start", () => {
    const event = only("Party am 17.10. von 22 bis 2 Uhr");
    expect(event.start).toBe("2026-10-17T22:00:00");
    expect(event.end).toBe("2026-10-18T02:00:00");
  });

  it("keeps the zone the mail names", () => {
    expect(only("Webinar on Oct 6 at 3pm PT").timeZone).toBe("America/Los_Angeles");
  });

  it("is surer about a full date with a time than about a weekday", () => {
    const full = only("Termin am 16.10.2026 um 14 Uhr");
    const weekday = only("Treffen wir uns am Freitag?");
    expect(full.confidence).toBeGreaterThan(0.85);
    expect(weekday.confidence).toBeLessThan(full.confidence);
    expect(weekday.confidence).toBeGreaterThanOrEqual(0.35);
  });

  it("trusts a date less when its weekday doesn't fit", () => {
    expect(only("Freitag, 17.10.2026").confidence).toBeLessThan(only("Samstag, 17.10.2026").confidence);
  });

  it("lists every hit once, in text order", () => {
    const events = detect(
      "Probe am 12.10. um 18 Uhr.\nGeneralprobe am 14.10. um 18 Uhr.\nPremiere am 16.10. um 20 Uhr.\nNochmal: Premiere am 16.10. um 20 Uhr!",
    );
    expect(events.map((event) => event.title)).toEqual(["Probe", "Generalprobe", "Premiere"]);
  });

  it("keeps at most `max`, the likeliest ones", () => {
    const text = Array.from({ length: 30 }, (_, index) => `Termin ${index + 1}: ${index + 1}.10.2026 um 10 Uhr`).join(
      "\n",
    );
    expect(detect(text, { max: 5 })).toHaveLength(5);
    expect(detect(text)).toHaveLength(20);
  });

  it("marks what was over before the mail came", () => {
    const event = only("Das Treffen am 25.9. war super, danke!");
    expect(event.past).toBe(true);
    expect(only("heute um 8 Uhr").past).toBe(true);
    expect(only("heute um 18 Uhr").past).toBe(false);
  });

  it("marks ambiguous slash dates and trusts them less", () => {
    const event = only("Meeting 10/12/2026 3pm", { locale: "en-US" });
    expect(event.start).toBe("2026-10-12T15:00:00");
    expect(event.ambiguous).toBe(true);
    const british = only("The meeting is on 10/12/2026 at 3pm", { locale: "en-GB" });
    expect(british.start).toBe("2026-12-10T15:00:00");
    const german = only("Das Meeting ist am 10/12/2026 um 15 Uhr", { locale: "en-US" });
    expect(german.start).toBe("2026-12-10T15:00:00");
  });
});

describe("false alarms", () => {
  it.each([
    "Bestellnummer: 12.10.2026",
    "Order no. 10/12/2026",
    "Tel.: 12.10.20",
    "Rechnungsdatum: 12.10.2026",
    "Invoice date: Oct 12, 2026",
    "Ihre Bestellung vom 12.09.2026 ist unterwegs",
    "Stand: 01.10.2026",
    "Kunden-Nr. 17.10.2026",
    "Gesendet: 28.09.2026",
    "Preis: 12.10 €",
    "Das kostet €12.10.",
    "Version 2.10.",
    "Kapitel 3.4.",
  ])("%s", (text) => {
    expect(detect(text)).toEqual([]);
  });

  it("skips the mail's own date", () => {
    expect(detect("Newsletter vom 29.09.2026\nHallo!")).toEqual([]);
    expect(detect("Newsletter 29.09.2026")).toEqual([]);
    // With a time it is an appointment today.
    expect(detect("Heute, 29.09.2026 um 18 Uhr: Lesung")).toHaveLength(1);
  });

  it("skips dates more than two years out", () => {
    expect(detect("Garantie bis 31.12.2031")).toEqual([]);
  });

  it("leaves out excluded ranges", () => {
    const text = "Neu: Termin am 16.10. um 10 Uhr\n> Alter Termin am 20.10. um 10 Uhr";
    const events = detect(text, { excluded: boilerplate(text, false) });
    expect(events.map((event) => event.start)).toEqual(["2026-10-16T10:00:00"]);
  });
});

describe("titles", () => {
  it.each([
    ["Prime Day deals vom 6. – 9. Okt", "Prime Day deals"],
    ["Das Sommerfest findet am 17.10. statt.", "Sommerfest"],
    ["The webinar starts on Oct 6 at 3pm.", "Webinar"],
    ["Unser Flohmarkt: Sa 17.10. ab 9 Uhr", "Flohmarkt"],
    ["Was: Lesung mit Mia\nWann: 17.10. um 19 Uhr", "Lesung mit Mia"],
    ["Herbstfest\nSa 17.10. ab 14 Uhr im Stadtpark", "Herbstfest"],
  ])("%s", (text, title) => {
    expect(only(text).title).toBe(title);
  });

  it("uses the subject without its dates when the sentence names nothing", () => {
    const event = only("Wir wollen Freitag ab 19 Uhr zocken.", { subject: "Re: Spieleabend am Freitag?" });
    expect(event.title).toBe("Spieleabend");
  });

  it("does not take a greeting for a heading", () => {
    const event = only("Hallo Mini,\nkannst du am 17.10. um 10 Uhr?", { subject: "Kurze Frage" });
    expect(event.title).toBe("Kurze Frage");
  });

  it("cleans subjects", () => {
    expect(subjectTitle("AW: WG: Grillen am Samstag, 17.10.!", REFERENCE, "de-DE")).toBe("Grillen");
    expect(subjectTitle("Fwd: Webinar on Oct 6", REFERENCE, "en-US")).toBe("Webinar");
    // Nothing but a date: no title at all rather than the date again.
    expect(subjectTitle("Re: am 17.10.", REFERENCE, "de-DE")).toBe("");
  });
});

describe("places", () => {
  it.each([
    ["Lesung am 17.10. um 19 Uhr\nOrt: Stadtbibliothek, Raum 2", "Stadtbibliothek, Raum 2"],
    ["Where: Main Hall\nWhen: Oct 6 at 3pm", "Main Hall"],
    ["Treffen am 17.10. um 19 Uhr im Café Lindenblüte", "Café Lindenblüte"],
    ["Meetup on Oct 6 at 6pm at the Grand Hall", "Grand Hall"],
    ["Am Freitag, 16.10. um 19:30 Uhr liest Leni im Café Lindenblüte aus ihrem Buch.", "Café Lindenblüte"],
    ["Leni reads at Café Lindenblüte on Friday, October 16 at 7:30pm.", "Café Lindenblüte"],
  ])("%s", (text, place) => {
    expect(only(text).location).toBe(place);
  });

  it("finds none where none is said", () => {
    expect(only("Termin am 17.10. um 19 Uhr").location).toBeNull();
  });

  it.each([
    "Im Anhang die Einladung für den 17.10. um 19 Uhr.",
    "Die Party am 17.10. um 19 Uhr steht in der Regel fest.",
    "Bei Fragen zum Termin am 17.10. um 19 Uhr melde dich.",
    "The call on Oct 6 at 3pm is at the Moment still on.",
  ])("takes no everyday phrase for a place: %s", (text) => {
    expect(only(text).location).toBeNull();
  });

  it("writes a poster's shouting title like a name", () => {
    expect(only("HERBSTFEST\nSa 17.10. · 14–18 Uhr").title).toBe("Herbstfest");
    expect(only("SUMMER OPEN-AIR\nSat Oct 17 · 2–6pm").title).toBe("Summer Open-Air");
  });
});

describe("quotes", () => {
  it("is the sentence the date stands in", () => {
    const event = only("Hallo! Das Sommerfest ist am 17.10. um 14 Uhr. Bring Kuchen mit.");
    expect(event.quote).toBe("Das Sommerfest ist am 17.10. um 14 Uhr.");
  });

  it("stays short for long lines", () => {
    const event = only(`${"bla ".repeat(100)}am 17.10. um 14 Uhr ${"bla ".repeat(100)}`);
    expect(event.quote.length).toBeLessThanOrEqual(240);
    expect(event.quote).toContain("17.10.");
  });
});

describe("language", () => {
  it("guesses German and English", () => {
    expect(guessLanguage("Wir sehen uns am Freitag und bringen die Snacks mit")).toBe("de");
    expect(guessLanguage("We will see you on Friday and bring the snacks")).toBe("en");
    expect(guessLanguage("12345")).toBeNull();
  });

  it("orders slash dates by language and region", () => {
    expect(slashOrderFor("de", "en-US")).toBe("DM");
    expect(slashOrderFor("en", "en-US")).toBe("MD");
    expect(slashOrderFor("en", "de-DE")).toBe("MD");
    expect(slashOrderFor("en", "en-GB")).toBe("DM");
    expect(slashOrderFor(null, "en-US")).toBe("MD");
    expect(slashOrderFor(null, "fr-FR")).toBe("DM");
  });
});

describe("boilerplate", () => {
  const slice = (text: string, forward = false) =>
    boilerplate(text, forward).map(([from, to]) => text.slice(from, to).split("\n")[0]);

  it("finds quoted lines and reply headers", () => {
    expect(slice("Neu\n> alt\nNeu\nAm 28.09.2026 um 10:15 schrieb Leni:\nalt")).toEqual([
      "> alt",
      "Am 28.09.2026 um 10:15 schrieb Leni:",
    ]);
    expect(slice("Hi\nOn Mon, Sep 28, 2026 at 10:15 AM Leni <leni@wanders.example> wrote:\nold")).toEqual([
      "On Mon, Sep 28, 2026 at 10:15 AM Leni <leni@wanders.example> wrote:",
    ]);
  });

  it("finds Outlook headers", () => {
    expect(slice("Ok\nVon: Leni\nGesendet: Montag, 28. September 2026 10:15\nAn: Mini\nalt")).toEqual(["Von: Leni"]);
    expect(slice("Ok\n-----Original Message-----\nFrom: Leni\nalt")).toEqual(["-----Original Message-----"]);
  });

  it("keeps a forwarded mail but not its header lines", () => {
    const text =
      "Schau mal\n---------- Forwarded message ---------\nFrom: Kino <kino@kino.example>\nDate: Mon, Sep 28, 2026\nSubject: Tickets\n\nVorstellung am 17.10. um 20 Uhr";
    const ranges = boilerplate(text, true);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0]![0], ranges[0]![1])).not.toContain("Vorstellung");
    expect(text.slice(ranges[0]![0], ranges[0]![1])).toContain("Date: Mon, Sep 28, 2026");
  });

  it("finds signatures and closings in the lower part", () => {
    expect(slice("Termin steht.\n-- \nLeni, Tel 17.10.")).toEqual(["-- "]);
    expect(slice(`${"Text. ".repeat(20)}\nViele Grüße\nLeni`)).toEqual(["Viele Grüße"]);
    // A closing word near the top is just a word.
    expect(slice(`Danke\n${"Text. ".repeat(40)}`)).toEqual([]);
  });

  it("finds legal footers in the lower part", () => {
    expect(
      slice(`${"Angebot. ".repeat(20)}\nImpressum: Shop GmbH, Amtsgericht Musterstadt HRB 1234\nStand 01.10.2026`),
    ).toEqual(["Impressum: Shop GmbH, Amtsgericht Musterstadt HRB 1234"]);
    expect(slice(`View in browser | Unsubscribe\n${"Deal. ".repeat(20)}`)).toEqual([]);
  });
});
