/**
 * The words the date finder knows, German and English, and the pieces of pattern built from them.
 * Everything is matched case-insensitively and with Unicode word edges: `\b` knows no umlauts.
 */

/** Month names and their abbreviations, 1-based. */
export const MONTHS: Record<string, number> = {
  januar: 1,
  jänner: 1,
  january: 1,
  jan: 1,
  jän: 1,
  februar: 2,
  feber: 2,
  february: 2,
  feb: 2,
  märz: 3,
  maerz: 3,
  march: 3,
  mär: 3,
  mrz: 3,
  mar: 3,
  april: 4,
  apr: 4,
  mai: 5,
  may: 5,
  juni: 6,
  june: 6,
  jun: 6,
  juli: 7,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  oktober: 10,
  october: 10,
  okt: 10,
  oct: 10,
  november: 11,
  nov: 11,
  dezember: 12,
  december: 12,
  dez: 12,
  dec: 12,
};

/** Weekdays, 0 is Sunday like Date.getDay. Full names only: these may stand on their own. */
export const WEEKDAYS_FULL: Record<string, number> = {
  sonntag: 0,
  sunday: 0,
  montag: 1,
  monday: 1,
  dienstag: 2,
  tuesday: 2,
  mittwoch: 3,
  wednesday: 3,
  donnerstag: 4,
  thursday: 4,
  freitag: 5,
  friday: 5,
  samstag: 6,
  sonnabend: 6,
  saturday: 6,
};

/** Short forms, only taken right in front of a date ("Fr., 17.10."): "so" and "do" are words too. */
export const WEEKDAYS_SHORT: Record<string, number> = {
  so: 0,
  sun: 0,
  mo: 1,
  mon: 1,
  di: 2,
  tue: 2,
  tues: 2,
  mi: 3,
  wed: 3,
  do: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  fr: 5,
  fri: 5,
  sa: 6,
  sat: 6,
};

const byLength = (words: string[]) => [...words].sort((a, b) => b.length - a.length).join("|");

/** No letter or digit right before. */
export const LB = "(?<![\\p{L}\\p{N}])";
/** No letter or digit right after. */
export const RB = "(?![\\p{L}\\p{N}])";
/** A day of the month, 1 to 31, with or without a leading zero. */
export const DAY = "(3[01]|[12]\\d|0?[1-9])";
/** A month name; group 1 is the name. A dot after an abbreviation belongs to it. */
export const MONTH = `(${byLength(Object.keys(MONTHS))})(?!\\p{L})\\.?`;
export const WEEKDAY_FULL = `(${byLength(Object.keys(WEEKDAYS_FULL))})`;
export const WEEKDAY_ANY = `(${byLength([...Object.keys(WEEKDAYS_FULL), ...Object.keys(WEEKDAYS_SHORT)])})`;
/** What joins the two ends of a range. */
export const DASH =
  "\\s{0,3}(?:[-–—‐‑]|bis(?:\\s+(?:zum|einschließlich|einschl\\.))?|to|through|thru|until|till)\\s{0,3}";
/** A four-digit year of this or the last century. */
export const YEAR = "((?:19|20)\\d{2})(?!\\d)";

export function monthOf(name: string): number {
  return MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? 0;
}

export function weekdayOf(name: string): number | null {
  const word = name.toLowerCase().replace(/\.$/, "");
  return WEEKDAYS_FULL[word] ?? WEEKDAYS_SHORT[word] ?? null;
}

/** Zone abbreviations a time may carry, as IANA zones. Matched case-sensitively. */
export const ZONES: Record<string, string> = {
  MEZ: "Europe/Berlin",
  MESZ: "Europe/Berlin",
  CET: "Europe/Berlin",
  CEST: "Europe/Berlin",
  UTC: "Etc/UTC",
  GMT: "Etc/UTC",
  BST: "Europe/London",
  EST: "America/New_York",
  EDT: "America/New_York",
  ET: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  CT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  PT: "America/Los_Angeles",
};

/** Words that make a line about something that happens. */
export const EVENT_CUES =
  /(?<![\p{L}])(termin|treffen|meeting|event|veranstaltung|konzert|concert|party|feier|fest|einladung|invitation|invite|appointment|webinar|call|workshop|seminar|konferenz|conference|sale|deals?|aktion|angebot|prime day|lieferung|zustellung|delivery|abholung|pickup|pick-up|frist|deadline|wann|when|uhrzeit|beginn|start|einlass|doors|anmeldung|registration|kurs|course|training|reservierung|reservation|check-in|flug|flight|abfahrt|departure|ankunft|arrival|vorstellung|show|premiere|release|launch|livestream|stream|spieleabend|game night|besprechung|review|interview|sprechstunde|geburtstag|birthday|hochzeit|wedding|essen|dinner|lunch|brunch|frühstück|breakfast)/iu;
