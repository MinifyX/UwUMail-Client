/**
 * The date finder against a table of invented mail snippets, German and English: what a reader
 * would put into the calendar for each one, and nothing for the ones that only look like dates.
 *
 * Each case is a text and the events it should give, written as
 *   "2026-10-03 10:00-12:00"            a time range
 *   "2026-10-03 18:00"                  a start without a known end
 *   "2026-10-03"                        an all-day event
 *   "2026-10-03..2026-10-05"            several days
 *   "2026-10-09 18:00-2026-10-11 14:00" across days
 * with " <IANA zone>" when the mail names one. No events: an empty list.
 *
 * All mails "arrive" on Friday, 2 October 2026 at 09:00 unless a case says otherwise.
 */

import { describe, expect, it } from "vitest";
import { addDays } from "@/lib/calendarDates";
import { detectEvents, type DetectedEvent } from "./detect";

const REFERENCE = "2026-10-02T09:00:00";

interface Case {
  text: string;
  expect: string[];
  subject?: string;
  title?: string;
  /** null: no place should be found. */
  location?: string | null;
  reference?: string;
}

function describeEvent(event: DetectedEvent): string {
  const startDay = event.start.slice(0, 10);
  const startClock = event.start.slice(11, 16);
  const endDay = event.end.slice(0, 10);
  const endClock = event.end.slice(11, 16);
  let text: string;
  if (event.allDay) {
    const last = addDays(endDay, -1);
    text = last === startDay ? startDay : `${startDay}..${last}`;
  } else if (!event.endKnown) {
    text = `${startDay} ${startClock}`;
  } else {
    text =
      endDay === startDay ? `${startDay} ${startClock}-${endClock}` : `${startDay} ${startClock}-${endDay} ${endClock}`;
  }
  return event.timeZone ? `${text} ${event.timeZone}` : text;
}

/** What the reader offers: events already over when the mail came are history and not shown. */
function runCase(item: Case): DetectedEvent[] {
  return detectEvents(item.text, {
    reference: item.reference ?? REFERENCE,
    subject: item.subject ?? "",
    locale: "de-DE",
  }).filter((event) => !event.past);
}

const c = (text: string, ...expected: string[]): Case => ({ text, expect: expected });

const SAT_10_12 = "2026-10-03 10:00-12:00";

/** The report that started it all, and every way people write the same thing. */
const TIME_RANGES_DE: Case[] = [
  c("Samstag 03.10.26, zwischen 10:00 und 12:00", SAT_10_12),
  c("Samstag, 03.10.2026 von 10:00 bis 12:00 Uhr", SAT_10_12),
  c("Sa. 03.10. 10–12 Uhr", SAT_10_12),
  c("Samstag, den 3. Oktober, 10 bis 12 Uhr", SAT_10_12),
  c("am 03.10. zwischen 10 und 12 Uhr", SAT_10_12),
  c("03.10.26 10:00-12:00", SAT_10_12),
  c("Am Samstag, 3.10., von 10 bis 12 Uhr", SAT_10_12),
  c("Samstag 03.10.26\nZeit: 10:00 – 12:00", SAT_10_12),
  c("Samstag 03.10.26\n10:00 - 12:00 Uhr", SAT_10_12),
  c("Sa, 3. Okt. 2026, 10.00–12.00 Uhr", SAT_10_12),
  c("Samstag, 03.10.26, zwischen 10 und 12", SAT_10_12),
  c("03.10.2026 | 10:00 - 12:00", SAT_10_12),
  c("am 3.10. um 10 Uhr bis 12 Uhr", SAT_10_12),
  c("Samstag, 3.10.2026, 10:00 Uhr bis 12:00 Uhr", SAT_10_12),
  c("Samstag 03.10.26 zwischen 10:00 Uhr und 12:00 Uhr", SAT_10_12),
  c("Termin: 03.10.2026, 10:00 – 12:00 Uhr (MESZ)", `${SAT_10_12} Europe/Berlin`),
  c("Sa 03.10. 10h-12h", SAT_10_12),
  c("Samstag, 3. Oktober 2026 · 10–12 Uhr", SAT_10_12),
  c("am 03.10. in der Zeit von 10 bis 12 Uhr", SAT_10_12),
  c("am 03.10. von 10.30 bis 12.15 Uhr", "2026-10-03 10:30-12:15"),
  c("am Samstag, den 03.10.2026 zwischen 10 und 12 Uhr", SAT_10_12),
  c("Samstag, 03.10.26 – 10:00 bis 12:00 Uhr", SAT_10_12),
  c("Sa., 03.10.2026, 10:00–12:00 Uhr", SAT_10_12),
  c("03.10.2026 von 10 – 12 Uhr", SAT_10_12),
  c("Samstag, 03. Oktober, zwischen 10.00 und 12.00 Uhr", SAT_10_12),
  c("am 3.10. von 10 bis 12", SAT_10_12),
  c("am 03.10. 10:00 Uhr – 12:00 Uhr", SAT_10_12),
  c("03.10.26 zw. 10 und 12 Uhr", SAT_10_12),
  c("am 03.10. von 22 bis 2 Uhr", "2026-10-03 22:00-2026-10-04 02:00"),
];

const TIMES_DE: Case[] = [
  c("am 17.10. um 19:30 Uhr", "2026-10-17 19:30"),
  c("am 17.10. ab 18 Uhr", "2026-10-17 18:00"),
  c("Freitag, 16.10., 18:30h", "2026-10-16 18:30"),
  c("am 16.10. um 9.30 Uhr", "2026-10-16 09:30"),
  c("Vorlesung am 14.10. um 14 Uhr c.t.", "2026-10-14 14:15"),
  c("Vorlesung am 14.10. um 14 Uhr s.t.", "2026-10-14 14:00"),
  c("am 20.10. gegen 15 Uhr", "2026-10-20 15:00"),
  c("am 20.10. um 8", "2026-10-20 08:00"),
  c("Treffen am 20.10. um halb drei", "2026-10-20 14:30"),
  c("am 20.10. um Viertel nach zehn", "2026-10-20 10:15"),
  c("am 21.10. um Viertel vor acht", "2026-10-21 19:45"),
  c("am 21.10. um drei Uhr nachmittags", "2026-10-21 15:00"),
  c("am 21.10. um 7 Uhr abends", "2026-10-21 19:00"),
  c("am 22.10. um 20 Uhr", "2026-10-22 20:00"),
  c("22.10.2026, 19 Uhr", "2026-10-22 19:00"),
  c("am 22.10. um 12 Uhr mittags", "2026-10-22 12:00"),
  c("am 24.10. um 19:30 Uhr (Einlass 18:30)", "2026-10-24 19:30"),
  c("Do., 8.10.2026 um 18 Uhr", "2026-10-08 18:00"),
  c("um 10 Uhr am Samstag", "2026-10-03 10:00"),
  c("um 14 Uhr am 05.10.", "2026-10-05 14:00"),
  c("von 10 bis 12 Uhr am Samstag, 03.10.", SAT_10_12),
  c("zwischen 10 und 12 Uhr am 03.10.", SAT_10_12),
  c("Beginn: 19 Uhr am 9.10.2026", "2026-10-09 19:00"),
  c("am 09.10. um 18.00h", "2026-10-09 18:00"),
  c("am 09.10. um 18:00 h", "2026-10-09 18:00"),
  c("am 09.10.2026 um 8:00 Uhr morgens", "2026-10-09 08:00"),
  c("am 09.10. um halb acht", "2026-10-09 19:30"),
  c("am 09.10. um elf Uhr", "2026-10-09 11:00"),
  c("Mittwoch, 07.10.2026\nUhrzeit: 15:00", "2026-10-07 15:00"),
  c("Mittwoch, 07.10.2026\nBeginn: 15 Uhr", "2026-10-07 15:00"),
];

/** Counted from the day the mail arrived, a Friday. */
const RELATIVE: Case[] = [
  c("morgen um 10 Uhr", "2026-10-03 10:00"),
  c("morgen zwischen 10 und 12 Uhr", SAT_10_12),
  c("übermorgen 14:00", "2026-10-04 14:00"),
  c("nächsten Dienstag um 9:30", "2026-10-06 09:30"),
  c("heute Abend um 8", "2026-10-02 20:00"),
  c("heute um 15 Uhr", "2026-10-02 15:00"),
  c("am Montag von 9 bis 11 Uhr", "2026-10-05 09:00-11:00"),
  c("kommenden Mittwoch, 18 Uhr", "2026-10-07 18:00"),
  c("Freitag um 16 Uhr", "2026-10-02 16:00"),
  c("am Freitag", "2026-10-09"),
  c("tomorrow at 3pm", "2026-10-03 15:00"),
  c("next Tuesday 10am-11am", "2026-10-06 10:00-11:00"),
  c("tonight at 8", "2026-10-02 20:00"),
  c("the day after tomorrow at 9", "2026-10-04 09:00"),
  c("on Monday between 2 and 4pm", "2026-10-05 14:00-16:00"),
  c("morgen früh um 7", "2026-10-03 07:00"),
  c("morgen Nachmittag um 3", "2026-10-03 15:00"),
  c("Guten Morgen, wir sehen uns um 10"),
  c("Wir hatten heute ein schönes Treffen."),
  c("am Samstag zwischen 10 und 12 Uhr", SAT_10_12),
  c("Samstag, 10–12 Uhr", SAT_10_12),
  c("diesen Samstag von 10:00 bis 12:00", SAT_10_12),
  c("am kommenden Samstag um 10", "2026-10-03 10:00"),
  c("this Saturday 10:00–12:00", SAT_10_12),
  c("on Saturday from 10 to 12", SAT_10_12),
  c("morgen, 9:00–17:00", "2026-10-03 09:00-17:00"),
  c("tomorrow, 9:00–17:00", "2026-10-03 09:00-17:00"),
  c("übermorgen ab 18 Uhr", "2026-10-04 18:00"),
  c("Jeden Montag um 18 Uhr ist Training."),
  c("Letzten Dienstag um 10 Uhr war das Treffen."),
];

const DATE_FORMS: Case[] = [
  c("am 3. Okt.", "2026-10-03"),
  c("am 3. Oktober 2026 um 10 Uhr", "2026-10-03 10:00"),
  c("am 03.10.26", "2026-10-03"),
  c("am 3.10.2026", "2026-10-03"),
  c("am 15. Januar", "2027-01-15"),
  c("am 15.1.", "2027-01-15"),
  c("am 5. Dez. um 10 Uhr", "2026-12-05 10:00"),
  c("2026-10-03 10:00", "2026-10-03 10:00"),
  c("2026-10-03 10:00–12:00", SAT_10_12),
  c("2026-10-03T10:00 bis 12:00", SAT_10_12),
  c("Mi 14.10.", "2026-10-14"),
  c("Dienstag, 13. Oktober", "2026-10-13"),
  c("Di 13.10 um 18 Uhr", "2026-10-13 18:00"),
  c("Samstag, 3.10.", "2026-10-03"),
  c("am 31.11."),
  c("am 3. Nov. 2026", "2026-11-03"),
  c("am 3 Nov", "2026-11-03"),
  c("am 03. Okt 2026, 10 Uhr", "2026-10-03 10:00"),
  c("Sonntag, 1. November 2026, 11:00 Uhr", "2026-11-01 11:00"),
  c("am 12. Dezember um 16 Uhr", "2026-12-12 16:00"),
  c("Mo. 05.10.26 9:00", "2026-10-05 09:00"),
  c("Montag, 5. Okt. 2026, 9 Uhr", "2026-10-05 09:00"),
  c("Datum: 05.10.2026\nUhrzeit: 09:00 – 10:30 Uhr", "2026-10-05 09:00-10:30"),
  c("Datum: Montag, 5. Oktober 2026\nZeit: 9 bis 10.30 Uhr", "2026-10-05 09:00-10:30"),
];

const ENGLISH: Case[] = [
  c("Oct 3, 2026 at 10am–12pm", SAT_10_12),
  c("Saturday, October 3 from 10:00 to 12:00", SAT_10_12),
  c("on 3 October 2026, 10am - 12pm", SAT_10_12),
  c("October 3rd at 2:30 PM", "2026-10-03 14:30"),
  c("Sat, Oct 3 · 10:00 – 12:00 CEST", `${SAT_10_12} Europe/Berlin`),
  c("Oct 3 10:00-12:00 CET", `${SAT_10_12} Europe/Berlin`),
  c("between 10am and noon on Saturday", SAT_10_12),
  c("3-5pm on Saturday, Oct 3", "2026-10-03 15:00-17:00"),
  c("The party is on 10/03/2026 at 3pm", "2026-10-03 15:00"),
  c("Wednesday, October 14, 2026 at 6:00 PM EDT", "2026-10-14 18:00 America/New_York"),
  c("Oct 14 at 9 a.m.", "2026-10-14 09:00"),
  c("on the 14th of October at noon", "2026-10-14 12:00"),
  c("Dec 5th, 7-9pm", "2026-12-05 19:00-21:00"),
  c("Thursday Oct 8th 6.30pm", "2026-10-08 18:30"),
  c("October 3, 2026 10:00 AM - 12:00 PM", SAT_10_12),
  c("Oct. 3 from 10 to 12", SAT_10_12),
  c("Meeting on Monday, Oct 5 at 14:00 UTC", "2026-10-05 14:00 Etc/UTC"),
  c("Oct 5–7", "2026-10-05..2026-10-07"),
  c("October 30 – November 2", "2026-10-30..2026-11-02"),
  c("from Oct 30 to Nov 2, 2026", "2026-10-30..2026-11-02"),
  c("Due by October 15", "2026-10-15"),
  c("deadline: Oct 15, 2026 at 11:59 PM", "2026-10-15 23:59"),
  c("Saturday, October 3, 2026, between 10 and 12", SAT_10_12),
  c("Sat Oct 3, 10:00am – 12:00pm (CET)", `${SAT_10_12} Europe/Berlin`),
  c("on October 3 between 10:00 and 12:00", SAT_10_12),
  c("Oct 3 @ 10am", "2026-10-03 10:00"),
  c("3 Oct 2026, 10:00–12:00 GMT", `${SAT_10_12} Etc/UTC`),
  c("Friday, Oct 9, 2026 | 7:00 PM – 9:00 PM", "2026-10-09 19:00-21:00"),
  c("at 10am on October 3rd", "2026-10-03 10:00"),
  c("Nov 3 at 9:15am PST", "2026-11-03 09:15 America/Los_Angeles"),
];

const MULTI_DAY: Case[] = [
  c("03.–05.10.", "2026-10-03..2026-10-05"),
  c("3.-5. Oktober", "2026-10-03..2026-10-05"),
  c("vom 3. bis 5. Oktober", "2026-10-03..2026-10-05"),
  c("vom 28.10. bis 03.11.2026", "2026-10-28..2026-11-03"),
  c("30.10.–2.11.", "2026-10-30..2026-11-02"),
  c("Fr 09.10. 18 Uhr bis So 11.10. 14 Uhr", "2026-10-09 18:00-2026-10-11 14:00"),
  c("09.10.2026 18:00 – 11.10.2026 14:00", "2026-10-09 18:00-2026-10-11 14:00"),
  c("Urlaub vom 19.10. bis zum 23.10.", "2026-10-19..2026-10-23"),
  c("19.10.–23.10.2026", "2026-10-19..2026-10-23"),
  c("Herbstferien 26.10. - 30.10.", "2026-10-26..2026-10-30"),
  c("Dec 28, 2026 – Jan 2, 2027", "2026-12-28..2027-01-02"),
  c("vom 03.10. bis 05.10.", "2026-10-03..2026-10-05"),
  c("Messe vom 12. bis 15. Okt. 2026", "2026-10-12..2026-10-15"),
  c("Sa 3.10. bis Mo 5.10.", "2026-10-03..2026-10-05"),
  c("3.–5.10.2026", "2026-10-03..2026-10-05"),
  c("Oct 12-15, 2026", "2026-10-12..2026-10-15"),
  c("12–15 October 2026", "2026-10-12..2026-10-15"),
  c("from 12 to 15 October", "2026-10-12..2026-10-15"),
  c("vom 30. September bis 2. Oktober", "2026-09-30..2026-10-02"),
  c("Sa., 03.10., 10 Uhr bis So., 04.10., 16 Uhr", "2026-10-03 10:00-2026-10-04 16:00"),
];

/** A last day to do something: an all-day entry on that day, or the hour when one is named. */
const DEADLINES: Case[] = [
  c("bis zum 15.10.", "2026-10-15"),
  c("Bitte bis 15.10.2026 zurücksenden.", "2026-10-15"),
  c("Anmeldeschluss: 15. Oktober", "2026-10-15"),
  c("spätestens am 15.10.", "2026-10-15"),
  c("fällig am 15.10.2026", "2026-10-15"),
  c("bis spätestens 15.10. um 12 Uhr", "2026-10-15 12:00"),
  c("Rückmeldung bitte bis Donnerstag, 15.10.", "2026-10-15"),
  c("Please reply by Oct 15.", "2026-10-15"),
  c("Abgabe bis 15.10.2026, 23:59 Uhr", "2026-10-15 23:59"),
  c("zahlbar bis 20.10.2026", "2026-10-20"),
];

/** Numbers that look like dates or times and are none. */
const NOT_DATES: Case[] = [
  c("Version 2.10.1 ist verfügbar"),
  c("Update auf v1.10.2026 installiert"),
  c("Preis: 10.00 €"),
  c("Gesamt 12.10 EUR"),
  c("Das kostet 3.10 €"),
  c("Tel. 0171 12.10.20"),
  c("Telefon: +49 30 1234 10.11"),
  c("IBAN: DE89 3704 0044 0532 0130 00"),
  c("Bestellnummer 12.10.2026-4711"),
  c("Sendungsnummer: 00340434161234567890"),
  c("Tracking: 1Z999AA10123456784"),
  c("Bestellung 302-1234567-1234567"),
  c("Der Server wird um 10 Uhr neu gestartet."),
  c("Das dauert 10 bis 12 Minuten."),
  c("Wir waren 10 bis 12 Personen."),
  c("Kapitel 3.10. beschreibt das genauer."),
  c("Rechnungsdatum: 01.10.2026"),
  c("Endstand 3:10 im Spiel."),
  c("Seite 12/10"),
  c("IP 192.0.2.10"),
  c("Abmessungen 10.10.5 cm"),
  c("Ihre Bestellung vom 28.09.2026"),
  c("PLZ 10115 Berlin"),
  c("Artikel 10.03 ist nicht lieferbar."),
  c("Ticket #12.10"),
  c("Das Paket wiegt 2.10 kg."),
  c("Sie sparen 10–12 %."),
  c("Nachricht vom 01.10.2026 10:15"),
  c("Gesendet: Donnerstag, 1. Oktober 2026 10:15"),
  c("Rechnung Nr. 2026-10-03"),
  c("Order #1003-2026"),
  c("Kundennummer: 03.10.2026"),
  c("Gutscheincode 1510-2026"),
  c("Ref: 03.10.26/4"),
  c("Lieferzeit 3-5 Werktage"),
  c("Rabatt 10.10 Prozent"),
  c("Öffnungszeiten: Mo–Fr 9–18 Uhr"),
  c("Akku 3.10 V"),
  c("Gewinnquote 10:12"),
  c("Konto 1234 03.10.2026"),
];

/** More than one appointment in the same mail. */
const SEVERAL: Case[] = [
  c("Probe am Di 06.10. um 19 Uhr, Konzert am Sa 10.10. um 20 Uhr", "2026-10-06 19:00", "2026-10-10 20:00"),
  c("Termine: 05.10. 10–11 Uhr und 07.10. 14–15 Uhr", "2026-10-05 10:00-11:00", "2026-10-07 14:00-15:00"),
  c("Aufbau Fr 09.10. ab 16 Uhr\nFest Sa 10.10. 14–22 Uhr", "2026-10-09 16:00", "2026-10-10 14:00-22:00"),
  c("Kick-off: Oct 5, 9am\nReview: Oct 9, 3-4pm", "2026-10-05 09:00", "2026-10-09 15:00-16:00"),
];

/** What the event is called and where it is. */
const TITLES: Case[] = [
  {
    ...c("Sommerfest am 10.10. um 15 Uhr im Stadtpark", "2026-10-10 15:00"),
    title: "Sommerfest",
    location: "Stadtpark",
  },
  {
    ...c("Betrag: 49,90 €\nFällig am 15.10.2026", "2026-10-15"),
    subject: "Deine Rechnung",
    title: "Rechnung",
    location: null,
  },
  {
    ...c("Wir treffen uns am 10.10. um 15 Uhr im Dorf.", "2026-10-10 15:00"),
    location: null,
  },
  {
    ...c("Lesung am 16.10. um 19:30 Uhr im Café Lindenblüte", "2026-10-16 19:30"),
    title: "Lesung",
    location: "Café Lindenblüte",
  },
  {
    ...c("Ort: Gemeindehaus, Kirchweg 3\nZeit: Samstag, 03.10., 10–12 Uhr", SAT_10_12),
    location: "Gemeindehaus, Kirchweg 3",
  },
  {
    ...c("Elternabend\nDienstag, 13.10.2026, 19:30 Uhr\nAula der Grundschule", "2026-10-13 19:30"),
    title: "Elternabend",
  },
  {
    ...c("Rechnungsbetrag 120,00 EUR, zahlbar bis 20.10.2026", "2026-10-20"),
    title: "",
  },
  {
    ...c("Dorffest am Samstag, 10.10., ab 14 Uhr auf dem Dorfplatz", "2026-10-10 14:00"),
    title: "Dorffest",
    location: "Dorfplatz",
  },
  {
    ...c("Kickoff call on Oct 6 at 3pm at the Main Office", "2026-10-06 15:00"),
    title: "Kickoff call",
    location: "Main Office",
  },
  {
    ...c("Treffpunkt: Bahnhof Musterstadt\nAbfahrt am 10.10. um 8:15 Uhr", "2026-10-10 08:15"),
    location: "Bahnhof Musterstadt",
  },
  {
    ...c("Zahnarzttermin am 08.10. um 9:30 Uhr in der Praxis Dr. Beispiel", "2026-10-08 09:30"),
    title: "Zahnarzttermin",
    location: "Praxis Dr. Beispiel",
  },
  {
    ...c("Gesamtbetrag: 89,00 €\nAbbuchung am 15.10.2026", "2026-10-15"),
    title: "Abbuchung",
  },
  {
    ...c("Hallo zusammen,\nSamstag 03.10.26, zwischen 10:00 und 12:00 ist Flohmarkt im Hof.", SAT_10_12),
    title: "Flohmarkt",
    location: null,
  },
  {
    ...c("Summe 12,50 €\nam 03.10. um 10 Uhr", "2026-10-03 10:00"),
    subject: "Abholung",
    title: "Abholung",
  },
  {
    ...c("Wir sind am 10.10. ab 14 Uhr im Garten.", "2026-10-10 14:00"),
    location: null,
  },
];

/** Shapes seen in real shipping, shop and account mails (invented content). */
const REAL_PATTERNS: Case[] = [
  {
    ...c("Ihre Sendung kommt heute zwischen 13:10 - 14:40 Uhr.", "2026-10-02 13:10-14:40"),
    reference: "2026-10-02T10:30:00",
  },
  c("Neuer Liefertermin\nDienstag 13/10/2026\nzwischen 09:00 - 11:00", "2026-10-13 09:00-11:00"),
  c("Voraussichtliche Zustellung\nMontag 05/10/2026\n10:15 - 12:15", "2026-10-05 10:15-12:15"),
  c("Datum: 20.10.2026\nZeitfenster: 14:00 – 16:00 Uhr", "2026-10-20 14:00-16:00"),
  c("Lieferung zwischen Mo. 12. Oktober und Fr. 16. Oktober", "2026-10-12..2026-10-16"),
  c("Lieferung zwischen Di. 13. und Mi. 14. Oktober", "2026-10-13..2026-10-14"),
  c("Delivery between Oct 12 and Oct 16", "2026-10-12..2026-10-16"),
  c("Ihr Paket wird am Mittwoch, den 07.10. zugestellt.", "2026-10-07"),
  c("Zustellung: Dienstag, 6 Oktober", "2026-10-06"),
  c("Dein Passwort wurde am 02.10.2026 um 08:30 Uhr geändert."),
  c("Anmeldung am 2026-10-02 07:00 UTC von einem neuen Gerät."),
  c("Login am 2026-10-02 09:00: neues Gerät"),
  c("Dein Paket wurde am 2. Oktober 2026 um 08:58 abgeholt."),
  c("Bezahlt am 2. Oktober 2026\nZeitraum 02.10.2026–01.11.2026"),
  c("Paid October 2, 2026\nOct 2 – Nov 2, 2026"),
  c("Ihre Bestellung 4711-0815 vom 01.10.2026"),
  c("Bestätigung zu Ihrem Auftrag 1234567890 vom 30.09.2026"),
  c("Customer ID 5ffa4ad2_2019-05-31"),
  c("Fri, Oct 9 7:00 PM – Sat, Oct 10 2:00 AM CEST", "2026-10-09 19:00-2026-10-10 02:00 Europe/Berlin"),
  c("Apple said on Monday that sales grew."),
  { ...c("Datum: 05.10.2026\nZeit: 10:00 Uhr", "2026-10-05 10:00"), subject: "Webinar", title: "Webinar" },
  {
    ...c("Ein neues Gerät hat sich am 2026-10-05 10:00 UTC angemeldet.", "2026-10-05 10:00 Etc/UTC"),
    subject: "Hinweis",
    title: "Hinweis",
  },
  {
    ...c("49,90 € am 11. November 2026\n49,90 € am 11. Dezember 2026", "2026-11-11", "2026-12-11"),
    subject: "Ratenplan",
    title: "Ratenplan",
  },
  { ...c("Der Vertrag tritt am 1. November 2026 in Kraft.", "2026-11-01"), location: null },
  c("Ihr Widerruf vom 21.09.2026 ist eingegangen."),
];

export const CORPUS: Record<string, Case[]> = {
  "time ranges (de)": TIME_RANGES_DE,
  "times (de)": TIMES_DE,
  relative: RELATIVE,
  "date forms": DATE_FORMS,
  english: ENGLISH,
  "multi-day": MULTI_DAY,
  deadlines: DEADLINES,
  "not dates": NOT_DATES,
  several: SEVERAL,
  "titles and places": TITLES,
  "real-world patterns": REAL_PATTERNS,
};

describe("date corpus", () => {
  for (const [group, cases] of Object.entries(CORPUS)) {
    describe(group, () => {
      it.each(cases.map((item) => [item.text.replace(/\n/g, " ⏎ "), item] as const))("%s", (_, item) => {
        const events = runCase(item);
        expect(events.map(describeEvent)).toEqual(item.expect);
        if (item.title !== undefined) expect(events[0]?.title).toBe(item.title);
        if (item.location !== undefined) expect(events[0]?.location ?? null).toBe(item.location);
      });
    });
  }

  it("has enough cases to mean something", () => {
    const total = Object.values(CORPUS).reduce((sum, cases) => sum + cases.length, 0);
    expect(total).toBeGreaterThanOrEqual(150);
  });
});
