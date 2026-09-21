// What UwUMail knows about attachment files, independent of where they come from.

export type AttachmentKind =
  "image" | "pdf" | "text" | "csv" | "json" | "audio" | "video" | "calendar" | "contact" | "other";

const EXTENSION_KINDS: Record<string, AttachmentKind> = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  avif: "image",
  bmp: "image",
  pdf: "pdf",
  txt: "text",
  log: "text",
  md: "text",
  markdown: "text",
  xml: "text",
  yml: "text",
  yaml: "text",
  ini: "text",
  toml: "text",
  js: "text",
  ts: "text",
  tsx: "text",
  jsx: "text",
  py: "text",
  rs: "text",
  java: "text",
  c: "text",
  cpp: "text",
  h: "text",
  cs: "text",
  go: "text",
  sh: "text",
  sql: "text",
  css: "text",
  html: "text",
  csv: "csv",
  tsv: "csv",
  json: "json",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  ics: "calendar",
  vcf: "contact",
};

/**
 * Same list as the engine (crates/uwumail-core/src/attachments.rs): files that run code when opened,
 * plus web pages, a common way to deliver fake login pages.
 */
const DANGEROUS = new Set(
  [
    "exe com bat cmd msi msix msixbundle appx appxbundle appref-ms application msp mst scr pif cpl lnk url reg inf",
    "ins isp hta chm hlp msc scf settingcontent-ms library-ms diagcab gadget js jse vbs vbe wsf wsh wsc sct ps1",
    "ps1xml ps2 psc1 psd1 psm1 jar jnlp app dmg pkg command sh run appimage deb rpm docm dotm xlsm xltm xlam xll",
    "pptm potm ppam sldm one iqy slk iso img vhd vhdx html htm xhtml shtml mht mhtml apk apks apkm xapk aab",
    "mobileconfig ipa shortcut wf webloc",
    // svg renders script and foreignObject when opened from disk; rdp/wsb/pub/desktop start a
    // connection, run a command or launch a program (webmail security audit W-7).
    "svg svgz rdp wsb pub desktop",
  ]
    .join(" ")
    .split(" "),
);

/** Android app packages: on the phone they can only be saved, never opened from a mail. */
const APP_PACKAGES = new Set(["apk", "apks", "apkm", "xapk", "aab"]);

/** What an iPhone installs: apps, Shortcuts, and profiles that can add certificates or device management. */
const IOS_INSTALLABLE = new Set(["mobileconfig", "ipa", "shortcut", "wf"]);

/** Characters that flip how text is displayed, used to disguise file names. */
const BIDI_CONTROLS = /[‎‏‪-‮⁦-⁩]/g;

export function extensionOf(filename: string): string {
  // A leading dot still names an extension ("‮.exe" cleans to ".exe"), so a name whose only dot is
  // first must not read as "no extension" and skip the dangerous-file check (webmail security audit W-6).
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function attachmentKind(filename: string, mimeType: string): AttachmentKind {
  const mime = mimeType.toLowerCase();
  if (mime === "text/calendar") return "calendar";
  if (mime === "text/vcard" || mime === "text/x-vcard") return "contact";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/csv") return "csv";
  if (mime === "application/json") return "json";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  const byExtension = EXTENSION_KINDS[extensionOf(filename)];
  if (byExtension) return byExtension;
  return mime.startsWith("text/") ? "text" : "other";
}

/** The extension that decides what a file does, ignoring direction tricks and trailing dots and spaces. */
function effectiveExtension(filename: string): string {
  // Windows ignores trailing dots and spaces, so "tool.exe. " still runs as tool.exe.
  return extensionOf(filename.replace(BIDI_CONTROLS, "").replace(/[. ]+$/, ""));
}

export function isDangerous(filename: string): boolean {
  return DANGEROUS.has(effectiveExtension(filename));
}

export function isAppPackage(filename: string): boolean {
  return APP_PACKAGES.has(effectiveExtension(filename));
}

export function isIosInstallable(filename: string): boolean {
  return IOS_INSTALLABLE.has(effectiveExtension(filename));
}

/** RFC 4180-ish CSV parsing: quoted fields, escaped quotes, commas/semicolons/tabs. */
export function parseCsv(text: string, maxRows = 500): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Unfolded `NAME;PARAMS:VALUE` lines of an iCalendar or vCard file. */
function contentLines(text: string): { name: string; params: string; value: string }[] {
  return text
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon < 0) return null;
      const head = line.slice(0, colon);
      const semicolon = head.indexOf(";");
      return {
        name: (semicolon < 0 ? head : head.slice(0, semicolon)).toUpperCase(),
        params: semicolon < 0 ? "" : head.slice(semicolon + 1),
        value: line.slice(colon + 1),
      };
    })
    .filter((line): line is { name: string; params: string; value: string } => line !== null);
}

const unescape = (value: string) =>
  value.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

/** `20260918T140000Z` or `20260918` to a Date. */
export function parseIcalDate(value: string): { date: Date; allDay: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, utc] = match;
  if (h === undefined) return { date: new Date(Number(y), Number(mo) - 1, Number(d)), allDay: true };
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
  return { date: utc ? new Date(Date.UTC(...parts)) : new Date(...parts), allDay: false };
}

export interface CalendarEvent {
  summary: string;
  start: { date: Date; allDay: boolean } | null;
  end: { date: Date; allDay: boolean } | null;
  location?: string;
  organizer?: string;
  description?: string;
  method?: string;
}

export function parseIcs(text: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let method: string | undefined;
  let current: CalendarEvent | null = null;
  for (const { name, params, value } of contentLines(text)) {
    if (name === "METHOD") method = value;
    if (name === "BEGIN" && value.toUpperCase() === "VEVENT") current = { summary: "", start: null, end: null, method };
    else if (name === "END" && value.toUpperCase() === "VEVENT" && current) {
      events.push(current);
      current = null;
    } else if (current) {
      if (name === "SUMMARY") current.summary = unescape(value);
      if (name === "DTSTART") current.start = parseIcalDate(value);
      if (name === "DTEND") current.end = parseIcalDate(value);
      if (name === "LOCATION") current.location = unescape(value);
      if (name === "DESCRIPTION") current.description = unescape(value);
      if (name === "ORGANIZER") {
        const cn = /CN="?([^";:]+)"?/i.exec(params)?.[1];
        current.organizer = cn ?? value.replace(/^mailto:/i, "");
      }
    }
  }
  return events;
}

export interface ContactCard {
  name: string;
  emails: string[];
  phones: string[];
  organization?: string;
  title?: string;
}

export function parseVcf(text: string): ContactCard[] {
  const cards: ContactCard[] = [];
  let current: ContactCard | null = null;
  for (const { name, value } of contentLines(text)) {
    if (name === "BEGIN" && value.toUpperCase() === "VCARD") current = { name: "", emails: [], phones: [] };
    else if (name === "END" && value.toUpperCase() === "VCARD" && current) {
      cards.push(current);
      current = null;
    } else if (current) {
      if (name === "FN") current.name = unescape(value);
      if (name === "N" && !current.name) current.name = value.split(";").slice(0, 2).reverse().join(" ").trim();
      if (name === "EMAIL") current.emails.push(value);
      if (name === "TEL") current.phones.push(value);
      if (name === "ORG") current.organization = unescape(value.split(";")[0] ?? "");
      if (name === "TITLE") current.title = unescape(value);
    }
  }
  return cards;
}
