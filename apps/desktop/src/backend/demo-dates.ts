// Demo mails with appointments in them, dated a few days after "now" so they always lie ahead.
// Fictional places and people only.

type Lang = "de" | "en";

const DAY = 86_400_000;

const locale = (lang: Lang) => (lang === "de" ? "de-DE" : "en-US");
const at = (now: number, days: number) => new Date(now + days * DAY);
/** The first `weekday` (0 = Sunday) at least `minDays` after now. */
function next(now: number, weekday: number, minDays: number): Date {
  const date = at(now, minDays);
  date.setDate(date.getDate() + ((weekday - date.getDay() + 7) % 7));
  return date;
}
const weekdayName = (date: Date, lang: Lang) => date.toLocaleDateString(locale(lang), { weekday: "long" });
const monthShort = (date: Date, lang: Lang) => date.toLocaleDateString(locale(lang), { month: "short" });
const monthLong = (date: Date, lang: Lang) => date.toLocaleDateString(locale(lang), { month: "long" });
const dayMonth = (date: Date) => `${date.getDate()}.${date.getMonth() + 1}.`;

/** "vom 6.–9. Okt." / "from Oct 6–9", also across two months. */
function range(first: Date, last: Date, lang: Lang): string {
  const sameMonth = first.getMonth() === last.getMonth();
  if (lang === "de") {
    return sameMonth
      ? `vom ${first.getDate()}.–${last.getDate()}. ${monthShort(last, lang)}`
      : `vom ${first.getDate()}. ${monthShort(first, lang)} – ${last.getDate()}. ${monthShort(last, lang)}`;
  }
  return sameMonth
    ? `from ${monthShort(first, lang)} ${first.getDate()}–${last.getDate()}`
    : `from ${monthShort(first, lang)} ${first.getDate()} – ${monthShort(last, lang)} ${last.getDate()}`;
}

/** A shop newsletter: a sale over several days, a hidden preheader and a footer with dates that don't count. */
export function saleMail(lang: Lang, now: number): string {
  const de = lang === "de";
  const first = at(now, 8);
  const last = at(now, 11);
  const stand = at(now, -3);
  return `<div class="preheader" style="display:none;max-height:0;overflow:hidden">${
    de ? `Nur bis ${dayMonth(at(now, 1))}: Vorab-Zugang` : `Early access until ${dayMonth(at(now, 1))}`
  }</div>
<div style="font-family:sans-serif;max-width:560px;margin:0 auto">
<h1 style="color:#1f2a5c;margin:0 0 8px">Pixel Days ⌨️</h1>
<p style="font-size:17px">${
    de
      ? `Pixel Days ${range(first, last, lang)}: bis zu 40\u00a0% auf alle Keycap-Sets.`
      : `Pixel Days ${range(first, last, lang)}: up to 40% off all keycap sets.`
  }</p>
<p>${
    de
      ? `Live-Unboxing mit Finn am ${weekdayName(at(now, 9), lang)}, ${dayMonth(at(now, 9))} um 18 Uhr auf unserem Kanal.`
      : `Live unboxing with Finn on ${weekdayName(at(now, 9), lang)}, ${monthLong(at(now, 9), lang)} ${at(now, 9).getDate()} at 6pm on our channel.`
  }</p>
<p><a href="https://pixelparts.example/pixel-days" style="background:#1f2a5c;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${
    de ? "Zu den Angeboten" : "See the deals"
  }</a></p>
<p style="font-size:12px;color:#888">${de ? "Bestellnummer" : "Order no."} 12.10.2048 · ${
    de ? "Preise inkl. MwSt." : "Prices incl. VAT."
  }</p>
<p style="font-size:11px;color:#999">Pixel Parts GmbH · ${de ? "Amtsgericht Musterstadt, HRB 4711" : "Registered in Musterstadt, HRB 4711"} · ${
    de ? "Stand" : "As of"
  } ${dayMonth(stand)}${stand.getFullYear()} · <a href="https://pixelparts.example/unsubscribe">${
    de ? "Abmelden" : "Unsubscribe"
  }</a></p>
</div>`;
}

/** A plain-text invitation among friends, with a quoted older date that doesn't count. */
export function readingMail(lang: Lang, now: number): string {
  const reading = at(now, 3);
  const earlier = at(now, -20);
  if (lang === "de") {
    return `Hey Mini!

Am ${weekdayName(reading, lang)}, ${dayMonth(reading)} um 19:30 Uhr liest Leni im Café Lindenblüte aus ihrem neuen Buch. Kommst du mit? 📚

Und nächsten Dienstag um 18 Uhr wollten wir doch noch telefonieren 🙂

LG Mia

> Am ${dayMonth(earlier)} um 18 Uhr war unser letzter Buchclub.`;
  }
  return `Hey Mini!

On ${weekdayName(reading, lang)}, ${monthLong(reading, lang)} ${reading.getDate()} at 7:30pm Leni is reading from her new book at Café Lindenblüte. Are you coming? 📚

And next Tuesday at 6pm we still wanted to call 🙂

Cheers, Mia

> Our last book club was on ${monthShort(earlier, lang)} ${earlier.getDate()} at 6pm.`;
}

/** The poster's date: the first Saturday at least five days ahead. */
const festDay = (now: number) => next(now, 6, 5);

/** The text the "server" reads from the poster, see DemoBackend.imageText. */
export function posterText(lang: Lang, now: number): string {
  const day = festDay(now);
  return lang === "de"
    ? `HERBSTFEST\nSa ${dayMonth(day)} · 14–18 Uhr\nKaffee & Kuchen · Lindenstraße 12\nKürbis-Chai · Livemusik · Kinderecke`
    : `AUTUMN FAIR\nSat ${monthShort(day, lang)} ${day.getDate()} · 2–6pm\nKaffee & Kuchen · Lindenstraße 12\nPumpkin chai · Live music · Kids' corner`;
}

function poster(lang: Lang, now: number): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const [title = "", when = "", where = "", extras = ""] = posterText(lang, now).split("\n");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 560" width="420" height="560">` +
    `<rect width="420" height="560" fill="#f08a24"/><circle cx="330" cy="110" r="70" fill="#ffd166"/>` +
    `<g font-family="Georgia, serif" fill="#3b2f2a">` +
    `<text x="32" y="250" font-size="46" font-weight="700">${escape(title)}</text>` +
    `<text x="32" y="310" font-size="26">${escape(when)}</text>` +
    `<text x="32" y="350" font-size="18">${escape(where)}</text>` +
    `<text x="32" y="500" font-size="15">${escape(extras)}</text></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** A mail whose appointment is only in its picture: the date finder needs the server's OCR here. */
export function posterMail(lang: Lang, now: number): string {
  const de = lang === "de";
  return `<div style="font-family:Arial,sans-serif;max-width:480px">
<p>${de ? "Ihr Lieben, unser Fest steht vor der Tür – alle Infos auf dem Plakat:" : "Dear all, our fair is coming up – everything's on the poster:"}</p>
<img src="${poster(lang, now)}" width="420" alt="${de ? "Plakat" : "Poster"}">
<p>${de ? "Wir freuen uns auf euch!" : "See you there!"}</p>
</div>`;
}
