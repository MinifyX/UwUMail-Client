// Fictional sample mail for `pnpm dev` and screenshots. No real people.

import type { Account, Address, Attachment, Folder, FolderRole, Message } from "./types";

type Lang = "de" | "en";
type Localized = Record<Lang, string>;

interface SampleMessage {
  from: Address;
  to?: Address[];
  minutesAgo: number;
  body: Localized;
  html?: boolean;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
  remote?: boolean;
  attachments?: Omit<Attachment, "id">[];
  folder?: FolderRole;
  /** A custom folder key from CUSTOM_FOLDERS instead of a role folder. */
  customFolder?: string;
}

interface SampleThread {
  account: "private" | "studio";
  subject: Localized;
  messages: SampleMessage[];
}

export const ME_PRIVATE: Address = { name: "Mini", email: "mini@uwumail.dev" };
export const ME_STUDIO: Address = { name: "Mini", email: "mini@pixelstudio.example" };

const leni: Address = { name: "Leni Wanders", email: "leni@wanders.example" };
const noah: Address = { name: "Noah Zockt", email: "noah@zockt.example" };
const mia: Address = { name: "Mia Mood", email: "mia@mood.example" };
const finn: Address = { name: "Finn Creates", email: "finn@creates.example" };
const bakery: Address = { name: "Kaffee & Kuchen", email: "hallo@kaffeekuchen.example" };
const shop: Address = { name: "Pixel Parts Shop", email: "orders@pixelparts.example" };
const bank: Address = { name: "Sparschwein Bank", email: "service@sparschwein.example" };
const client: Address = { name: "Emma Vogt", email: "emma.vogt@brightlabs.example" };
const lukas: Address = { name: "Lukas Editz", email: "lukas@pixelstudio.example" };

const p = (de: string, en: string): Localized => ({ de, en });

/**
 * A typical table-based newsletter: <style> first, fixed 600px layout and a
 * body stretched to 100% height. These are the cases that break naive readers.
 */
function newsletter(lang: Lang): string {
  const sets = [
    "Bubblegum",
    "Matcha",
    "Midnight",
    "Sakura",
    "Lavender",
    "Peach",
    "Ocean",
    "Forest",
    "Cloud",
    "Ember",
    "Mint",
    "Honey",
  ];
  const rows = sets
    .map(
      (name, index) =>
        `<tr><td class="card"><h3>${index + 1}. ${name}</h3><p>${
          lang === "de"
            ? "PBT-Doubleshot, 142 Tasten, passt auf die meisten Tastaturen."
            : "PBT double-shot, 142 keys, fits most keyboards."
        }</p><a class="cta" href="https://pixelparts.example/sets/${name.toLowerCase()}">${lang === "de" ? "Ansehen" : "View"}</a></td></tr>`,
    )
    .join("");
  return `<style>
html, body { height: 100%; }
body { font-family: Georgia, serif; }
#wrapper { background: #f4efe9; padding: 24px 0; }
#wrapper > table { margin: 0 auto; background: #ffffff; border-radius: 12px; }
td.card { padding: 20px 28px; border-bottom: 1px solid #eee4d8; }
td.card h3 { margin: 0 0 6px; color: #3b2f2a; font-size: 18px; }
.cta { display: inline-block; margin-top: 8px; padding: 8px 14px; background: #3b2f2a; color: #ffffff !important; border-radius: 6px; text-decoration: none; }
</style>
<div id="wrapper"><table width="600" cellpadding="0" cellspacing="0" role="presentation">
<tr><td style="padding:28px;text-align:center"><h1 style="margin:0;color:#3b2f2a">${
    lang === "de" ? "Hallo Herbst!" : "Hello autumn!"
  }</h1><p style="color:#7a6a5f">${lang === "de" ? "Zwölf neue Sets sind da." : "Twelve new sets just landed."}</p></td></tr>
${rows}
<tr><td style="padding:20px;text-align:center;font-size:12px;color:#9a8a7f">Pixel Parts · <a href="https://pixelparts.example/unsubscribe">${
    lang === "de" ? "Abmelden" : "Unsubscribe"
  }</a></td></tr>
</table></div>`;
}

/** A colorful promo made of big colored blocks: automatic dark mode should leave it light. */
function promo(lang: Lang): string {
  const de = lang === "de";
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="font-family:Arial,sans-serif">
<tr><td bgcolor="#f08a24" style="padding:48px 32px;text-align:center;color:#ffffff">
<h1 style="margin:0;font-size:34px">${de ? "2 für 1 auf alle Zimtschnecken" : "2 for 1 on all cinnamon rolls"}</h1>
<p style="margin:12px 0 0;font-size:18px">${de ? "Nur dieses Wochenende" : "This weekend only"}</p></td></tr>
<tr><td bgcolor="#2f7d4a" style="padding:36px 32px;color:#ffffff">
<h2 style="margin:0 0 8px">${de ? "Neu: Kürbis-Chai" : "New: pumpkin chai"}</h2>
<p style="margin:0">${de ? "Mit Hafermilch, Zimt und einer Prise Muskat." : "With oat milk, cinnamon and a pinch of nutmeg."}</p></td></tr>
<tr><td bgcolor="#fde7ef" style="padding:28px 32px;color:#8d0f43">
<p style="margin:0">${de ? "Zeig diese Mail an der Kasse. Gilt bis Sonntag, 18 Uhr." : "Show this mail at the counter. Valid until Sunday, 6 pm."}</p></td></tr>
<tr><td bgcolor="#3b2f2a" style="padding:20px 32px;color:#f4efe9;font-size:12px;text-align:center">Kaffee &amp; Kuchen · Lindenstraße 12</td></tr>
</table>`;
}

export const SAMPLE_THREADS: SampleThread[] = [
  {
    account: "private",
    subject: p("Hast du den neuen Clip gesehen?", "Did you see the new clip?"),
    messages: [
      {
        from: leni,
        minutesAgo: 190,
        seen: true,
        body: p(
          "Hey! Ich hab gestern den Sonnenuntergang an der Küste gefilmt. Magst du mal drüberschauen, bevor ich ihn hochlade?",
          "Hey! I filmed the sunset at the coast yesterday. Want to take a look before I upload it?",
        ),
      },
      {
        from: ME_PRIVATE,
        to: [leni],
        minutesAgo: 170,
        seen: true,
        folder: "sent",
        body: p("Noch nicht! Worum geht's genau?", "Not yet! What's it about?"),
      },
      {
        from: leni,
        minutesAgo: 12,
        body: p(
          "Ein neuer Chill-Vibe zum Abschalten, 30 Sekunden, ganz ohne Musik. Genau dein Ding, glaube ich 🌅",
          "A new chill vibe to switch off, 30 seconds, no music at all. Exactly your thing, I think 🌅",
        ),
        attachments: [
          { filename: "sonnenuntergang-vorschau.jpg", mimeType: "image/jpeg", size: 482_113, inline: false },
        ],
      },
    ],
  },
  {
    account: "private",
    subject: p("Spieleabend am Freitag?", "Game night on Friday?"),
    messages: [
      {
        from: noah,
        minutesAgo: 41,
        body: p(
          "Wir wollen Freitag ab 19 Uhr zocken. Ich bring Snacks mit, du die Controller? Sag Bescheid, ob du dabei bist!",
          "We're planning to play on Friday from 7pm. I'll bring snacks, you bring the controllers? Let me know if you're in!",
        ),
        attachments: [{ filename: "spieleabend-jingle.wav", mimeType: "audio/wav", size: 53_000, inline: false }],
      },
    ],
  },
  {
    account: "studio",
    subject: p("Feedback zum Logo-Entwurf", "Feedback on the logo draft"),
    messages: [
      {
        from: client,
        minutesAgo: 95,
        flagged: true,
        body: p(
          "Hallo Mini,\n\nwir haben uns die drei Varianten angesehen. Variante B gefällt dem Team am besten, nur das Pink dürfte etwas kräftiger sein. Schaffst du eine Überarbeitung bis Mittwoch?\n\nViele Grüße\nEmma",
          "Hi Mini,\n\nwe looked at the three options. The team likes option B best, the pink could just be a bit bolder. Could you manage a revision by Wednesday?\n\nBest\nEmma",
        ),
        attachments: [
          { filename: "logo-varianten.pdf", mimeType: "application/pdf", size: 1_204_331, inline: false },
          { filename: "notizen.txt", mimeType: "text/plain", size: 2_048, inline: false },
          { filename: "logo-review.ics", mimeType: "text/calendar", size: 612, inline: false },
        ],
      },
    ],
  },
  {
    account: "private",
    subject: p("Deine Bestellung ist unterwegs 📦", "Your order is on its way 📦"),
    messages: [
      {
        from: shop,
        minutesAgo: 60 * 5,
        html: true,
        remote: true,
        body: p(
          '<div style="font-family:sans-serif;max-width:520px"><img src="https://tracking.pixelparts.example/open.gif" width="1" height="1" alt=""><h2 style="color:#333">Gute Nachrichten!</h2><p>Deine Tastatur-Keycaps <b>„Bubblegum“</b> wurden verschickt und kommen voraussichtlich <b>Donnerstag</b> an.</p><p><a href="https://pixelparts.example/track/UWU-2048" style="background:#222;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Sendung verfolgen</a></p><img src="https://cdn.pixelparts.example/keycaps.jpg" width="480" alt="Keycaps"></div>',
          '<div style="font-family:sans-serif;max-width:520px"><img src="https://tracking.pixelparts.example/open.gif" width="1" height="1" alt=""><h2 style="color:#333">Good news!</h2><p>Your <b>"Bubblegum"</b> keycaps have shipped and should arrive on <b>Thursday</b>.</p><p><a href="https://pixelparts.example/track/UWU-2048" style="background:#222;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Track package</a></p><img src="https://cdn.pixelparts.example/keycaps.jpg" width="480" alt="Keycaps"></div>',
        ),
      },
    ],
  },
  {
    account: "studio",
    subject: p("Renderfarm ist wieder online", "Render farm is back online"),
    messages: [
      {
        from: lukas,
        minutesAgo: 60 * 7,
        seen: true,
        body: p(
          "Kurze Info: Die Renderfarm läuft wieder. Die Warteschlange von gestern wird gerade abgearbeitet, dein Projekt ist auf Platz 3.",
          "Quick heads-up: the render farm is running again. Yesterday's queue is being processed, your project is number 3.",
        ),
        attachments: [
          { filename: "render-queue.csv", mimeType: "text/csv", size: 164, inline: false },
          { filename: "lukas-editz.vcf", mimeType: "text/vcard", size: 140, inline: false },
        ],
      },
      {
        from: ME_STUDIO,
        to: [lukas],
        minutesAgo: 60 * 6,
        seen: true,
        folder: "sent",
        body: p("Danke dir! 🙏", "Thank you! 🙏"),
      },
    ],
  },
  {
    account: "private",
    subject: p("Ihre Rechnung Nr. 2026-0914", "Your invoice no. 2026-0914"),
    messages: [
      {
        from: { name: "Buchhaltung", email: "rechnung@zahlung-service.example" },
        minutesAgo: 60 * 9,
        body: p(
          "Sehr geehrter Kunde,\n\nanbei Ihre offene Rechnung. Bitte öffnen Sie den Anhang und begleichen Sie den Betrag innerhalb von 24 Stunden.",
          "Dear customer,\n\nplease find your open invoice attached. Open the attachment and pay within 24 hours.",
        ),
        attachments: [
          { filename: "Rechnung_2026-0914.pdf.exe", mimeType: "application/x-msdownload", size: 4, inline: false },
        ],
      },
    ],
  },
  {
    account: "private",
    subject: p("Neue Herbstkarte ☕", "New autumn menu ☕"),
    messages: [
      {
        from: bakery,
        minutesAgo: 60 * 26,
        seen: true,
        html: true,
        body: p(
          '<div style="font-family:Georgia,serif"><h1 style="color:#8a4b2a">Hallo Herbst!</h1><p>Ab heute gibt es Kürbis-Zimtschnecken und unseren Chai Latte mit Hafermilch.</p><p>Bis bald in der Kuchenecke!</p></div>',
          '<div style="font-family:Georgia,serif"><h1 style="color:#8a4b2a">Hello autumn!</h1><p>Starting today: pumpkin cinnamon rolls and our oat milk chai latte.</p><p>See you soon in the cake corner!</p></div>',
        ),
      },
    ],
  },
  {
    account: "private",
    subject: p("Absturz beim Öffnen von Anhängen", "Crash when opening attachments"),
    messages: [
      {
        from: finn,
        minutesAgo: 60 * 3,
        customFolder: "projects-uwumail-bugs",
        body: p(
          "Wenn ich einen PDF-Anhang doppelt anklicke, passiert gar nichts. Kannst du dir das mal ansehen?",
          "Double-clicking a PDF attachment does nothing at all. Could you take a look?",
        ),
      },
    ],
  },
  {
    account: "private",
    subject: p("Herbst-Aktion: 2 für 1 🎃", "Autumn deal: 2 for 1 🎃"),
    messages: [
      {
        from: bakery,
        minutesAgo: 60 * 29,
        seen: true,
        html: true,
        body: p(promo("de"), promo("en")),
      },
    ],
  },
  {
    account: "private",
    subject: p("Haha nein, war nur Spaß", "Haha no, just kidding"),
    messages: [
      {
        from: mia,
        minutesAgo: 60 * 30,
        seen: true,
        answered: true,
        body: p(
          "Ich zieh natürlich nicht nach Island. Aber ein Urlaub dort wär schon was, oder? 😄",
          "Of course I'm not moving to Iceland. But a holiday there would be something, right? 😄",
        ),
      },
    ],
  },
  {
    account: "private",
    subject: p("Herbst-Newsletter: 12 neue Keycap-Sets", "Autumn newsletter: 12 new keycap sets"),
    messages: [
      {
        from: shop,
        minutesAgo: 60 * 27,
        seen: true,
        html: true,
        body: p(newsletter("de"), newsletter("en")),
      },
    ],
  },
  {
    account: "private",
    subject: p("Dein Kontoauszug für August", "Your statement for August"),
    messages: [
      {
        from: bank,
        minutesAgo: 60 * 48,
        seen: true,
        body: p(
          "Dein Kontoauszug für August steht in deinem Online-Banking bereit. Aus Sicherheitsgründen senden wir keine Links per Mail.",
          "Your August statement is ready in online banking. For your security, we never send links by email.",
        ),
      },
    ],
  },
  {
    account: "studio",
    subject: p("Schick mir mal den Link", "Send me the link"),
    messages: [
      {
        from: finn,
        minutesAgo: 60 * 72,
        seen: true,
        body: p(
          "Du hattest von diesem Tool für Farbpaletten erzählt. Schick mir mal den Link, ich find ihn nicht mehr.",
          "You mentioned that color palette tool. Send me the link, I can't find it anymore.",
        ),
      },
    ],
  },
];

export const DEMO_ACCOUNTS: Account[] = [
  {
    id: "acc-private",
    name: "Privat",
    email: ME_PRIVATE.email,
    displayName: "Mini",
    color: "pink",
    auth: "password",
    status: { state: "idle" },
  },
  {
    id: "acc-studio",
    name: "Studio",
    email: ME_STUDIO.email,
    displayName: "Mini",
    color: "violet",
    auth: "microsoft",
    status: { state: "idle" },
  },
];

const FOLDER_NAMES: Record<FolderRole, Localized> = {
  inbox: p("Posteingang", "Inbox"),
  sent: p("Gesendet", "Sent"),
  drafts: p("Entwürfe", "Drafts"),
  archive: p("Archiv", "Archive"),
  trash: p("Papierkorb", "Trash"),
  junk: p("Spam", "Junk"),
};

const ROLES: FolderRole[] = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

/** Custom folders, nested like a real mailbox: [key, parent key, German name, English name]. */
const CUSTOM_FOLDERS: [string, string | null, string, string][] = [
  ["receipts", null, "Rechnungen", "Receipts"],
  ["clients", null, "Kunden", "Clients"],
  ["clients-bright", "clients", "Bright Labs", "Bright Labs"],
  ["clients-bakery", "clients", "Kaffee & Kuchen", "Kaffee & Kuchen"],
  ["projects", null, "Projekte", "Projects"],
  ["projects-uwumail", "projects", "UwUMail", "UwUMail"],
  ["projects-uwumail-bugs", "projects-uwumail", "Bugs", "Bugs"],
  ["projects-uwumail-ideas", "projects-uwumail", "Ideen", "Ideas"],
];

export function buildFolders(accountId: string, lang: Lang): Folder[] {
  const folders: Folder[] = ROLES.map((role) => ({
    id: `${accountId}:${role}`,
    accountId,
    name: FOLDER_NAMES[role][lang],
    path: role.toUpperCase(),
    role,
    parentId: null,
    selectable: true,
    unread: 0,
    total: 0,
  }));
  for (const [key, parent, de, en] of CUSTOM_FOLDERS) {
    folders.push({
      id: `${accountId}:${key}`,
      accountId,
      name: lang === "de" ? de : en,
      path: key.replace(/-/g, "/"),
      role: null,
      parentId: parent ? `${accountId}:${parent}` : null,
      selectable: true,
      unread: 0,
      total: 0,
    });
  }
  return folders;
}

export function buildMessages(lang: Lang, now = Date.now()): Message[] {
  const messages: Message[] = [];
  let counter = 0;
  SAMPLE_THREADS.forEach((thread, threadIndex) => {
    const accountId = thread.account === "private" ? "acc-private" : "acc-studio";
    const me = thread.account === "private" ? ME_PRIVATE : ME_STUDIO;
    const threadId = `thr-${threadIndex + 1}`;
    for (const sample of thread.messages) {
      counter += 1;
      const body = sample.body[lang];
      const text = sample.html
        ? body
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : body;
      const isReply = messages.some((m) => m.threadId === threadId);
      messages.push({
        id: `msg-${counter}`,
        threadId,
        accountId,
        folderId: `${accountId}:${sample.customFolder ?? sample.folder ?? "inbox"}`,
        from: sample.from,
        to: sample.to ?? [me],
        cc: [],
        replyTo: [],
        subject: (isReply ? "Re: " : "") + thread.subject[lang],
        date: new Date(now - sample.minutesAgo * 60_000).toISOString(),
        flags: {
          seen: sample.seen ?? false,
          flagged: sample.flagged ?? false,
          answered: sample.answered ?? false,
          draft: false,
        },
        snippet: text.slice(0, 140),
        bodyHtml: sample.html ? body : null,
        bodyText: sample.html ? text : body,
        hasRemoteContent: sample.remote ?? false,
        attachments: (sample.attachments ?? []).map((a, i) => ({ ...a, id: `att-${counter}-${i}` })),
      });
    }
  });
  return messages;
}

export function welcomeMessage(lang: Lang, id: string): Message {
  const from: Address = { name: "UwUMail", email: "hello@uwumail.dev" };
  const subject = lang === "de" ? "Willkommen bei UwUMail (◕‿◕✿)" : "Welcome to UwUMail (◕‿◕✿)";
  const text =
    lang === "de"
      ? "Schön, dass du da bist! Das hier ist eine Demo-Mail, sie kam gerade frisch rein. Probier mal die Tastenkürzel aus: c zum Schreiben, / zum Suchen."
      : "So happy you're here! This is a demo message that just arrived. Try the shortcuts: c to compose, / to search.";
  return {
    id,
    threadId: `thr-${id}`,
    accountId: "acc-private",
    folderId: "acc-private:inbox",
    from,
    to: [ME_PRIVATE],
    cc: [],
    replyTo: [],
    subject,
    date: new Date().toISOString(),
    flags: { seen: false, flagged: false, answered: false, draft: false },
    snippet: text.slice(0, 140),
    bodyHtml: null,
    bodyText: text,
    hasRemoteContent: false,
    attachments: [],
  };
}
