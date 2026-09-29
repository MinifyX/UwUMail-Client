import { describe, expect, it } from "vitest";
import { eventsInImageText, eventsInMail } from "@/lib/dates";
import { textToHtml } from "@/lib/format";
import { buildMessages, DEMO_IMAGE_TEXT } from "./demo-data";

const NOW = new Date(2026, 8, 29, 10).getTime();

function reference(date: string) {
  const local = new Date(date);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}:00`;
}

describe("demo mails with appointments", () => {
  for (const lang of ["de", "en"] as const) {
    it(`finds the sale, the reading and the poster's fair ahead of now (${lang})`, () => {
      const messages = buildMessages(lang, NOW);
      const bySubject = (part: string) => messages.find((message) => message.subject.includes(part))!;
      const found = (part: string) => {
        const message = bySubject(part);
        const html = message.bodyHtml ?? textToHtml(message.bodyText ?? "");
        const context = { subject: message.subject, reference: reference(message.date), locale: lang };
        return { message, context, events: eventsInMail(html, context).filter((event) => !event.past) };
      };

      const sale = found("Pixel Days");
      expect(sale.events.some((event) => event.allDay && event.end > event.start)).toBe(true);
      const reading = found(lang === "de" ? "Lesung" : "reading");
      expect(reading.events.length).toBeGreaterThanOrEqual(1);

      const poster = found(lang === "de" ? "Herbstfest" : "autumn fair");
      expect(poster.events).toEqual([]);
      const text = DEMO_IMAGE_TEXT.get(poster.message.id);
      expect(text).toBeTruthy();
      const fair = eventsInImageText(text!, poster.context);
      expect(fair).toHaveLength(1);
      expect(fair[0]).toMatchObject({ source: "image", allDay: false, past: false });
    });
  }
});
