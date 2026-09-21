import { describe, expect, it } from "vitest";
import { attachmentKind, isAppPackage, isDangerous, parseCsv, parseIcalDate, parseIcs, parseVcf } from "./attachments";

describe("attachmentKind", () => {
  it("uses the MIME type first and the extension as fallback", () => {
    expect(attachmentKind("foto.bin", "image/jpeg")).toBe("image");
    expect(attachmentKind("angebot.PDF", "application/octet-stream")).toBe("pdf");
    expect(attachmentKind("termin.ics", "text/calendar")).toBe("calendar");
    expect(attachmentKind("liste.csv", "application/vnd.ms-excel")).toBe("csv");
    expect(attachmentKind("setup.exe", "application/x-msdownload")).toBe("other");
    expect(attachmentKind("readme", "text/plain")).toBe("text");
  });

  it("flags files that run code, even with a harmless looking name", () => {
    expect(isDangerous("Rechnung_2026.pdf.exe")).toBe(true);
    expect(isDangerous("makro.XLSM")).toBe(true);
    expect(isDangerous("rechnung.pdf")).toBe(false);
  });

  it("flags a name whose only dot is first, and more lure formats (W-6, W-7)", () => {
    expect(isDangerous(".exe")).toBe(true);
    expect(isDangerous("‮.exe")).toBe(true);
    expect(isDangerous("‎.html")).toBe(true);
    expect(isDangerous("login.svg")).toBe(true);
    expect(isDangerous("remote.rdp")).toBe(true);
    expect(isDangerous("sandbox.wsb")).toBe(true);
    expect(isDangerous(".pdf")).toBe(false);
    // svg stays an image for its preview, even though saving it warns.
    expect(attachmentKind("logo.svg", "image/svg+xml")).toBe("image");
  });

  it("knows Android app packages", () => {
    expect(isDangerous("Update.APK")).toBe(true);
    expect(isAppPackage("spiel.xapk. ")).toBe(true);
    expect(isAppPackage("apk.pdf")).toBe(false);
  });
});

describe("parseCsv", () => {
  it("handles quotes, escaped quotes and semicolons", () => {
    const rows = parseCsv('Name;Betrag;Notiz\r\n"Kaffee & Kuchen";12,50;"sagt ""hallo"""\nPixel Parts;99;\n');
    expect(rows).toEqual([
      ["Name", "Betrag", "Notiz"],
      ["Kaffee & Kuchen", "12,50", 'sagt "hallo"'],
      ["Pixel Parts", "99", ""],
    ]);
  });
});

describe("iCalendar", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "SUMMARY:Logo-Review\\, Runde 2",
    "DTSTART:20260918T120000Z",
    "DTEND:20260918T130000Z",
    "LOCATION:Bright Labs\\, Raum 4",
    'ORGANIZER;CN="Emma Vogt":mailto:emma.vogt@brightlabs.example',
    "DESCRIPTION:Wir schauen uns Variante B an.\\nBitte Entwürfe mitbringen.",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("reads events with organizer, location and escaped text", () => {
    const [event] = parseIcs(ics);
    expect(event).toMatchObject({
      summary: "Logo-Review, Runde 2",
      location: "Bright Labs, Raum 4",
      organizer: "Emma Vogt",
      method: "REQUEST",
    });
    expect(event!.start!.date.toISOString()).toBe("2026-09-18T12:00:00.000Z");
    expect(event!.description).toContain("\n");
  });

  it("parses all-day dates", () => {
    expect(parseIcalDate("20261224")).toMatchObject({ allDay: true });
    expect(parseIcalDate("gestern")).toBeNull();
  });
});

describe("vCard", () => {
  it("reads name, addresses, phone and organization, including folded lines", () => {
    const [card] = parseVcf(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Lukas Editz\r\nORG:Pixel Studio;Schnitt\r\nTITLE:Cutter\r\nEMAIL;TYPE=work:lukas@pixel\r\n studio.example\r\nTEL:+49 30 1234567\r\nEND:VCARD\r\n",
    );
    expect(card).toEqual({
      name: "Lukas Editz",
      emails: ["lukas@pixelstudio.example"],
      phones: ["+49 30 1234567"],
      organization: "Pixel Studio",
      title: "Cutter",
    });
  });
});
