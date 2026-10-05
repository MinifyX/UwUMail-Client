import { describe, expect, it } from "vitest";
import type { Message } from "@/backend/types";
import { teamsMeetingLink } from "@/lib/outlook";
import {
  buildDocument,
  buildPrintDocument,
  fixViewportHeightUnits,
  isRunaway,
  readableBody,
  resolveAppearance,
  ROOT_ID,
} from "./MessageBody";

function message(patch: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "t1",
    accountId: "a1",
    folderId: "f1",
    from: { email: "news@shop.example" },
    to: [],
    cc: [],
    replyTo: [],
    subject: "News",
    date: "2026-09-14T10:00:00Z",
    flags: { seen: false, flagged: false, answered: false, draft: false },
    snippet: "",
    bodyHtml: null,
    bodyText: null,
    hasRemoteContent: false,
    attachments: [],
    ...patch,
  };
}

describe("Microsoft Safe Links", () => {
  const wrapped =
    "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwanders.example%2Fclip%3Fv%3D2&data=05%7C02&reserved=0";

  it("show and link the address they wrap, marked for the link question", () => {
    const html = readableBody(
      message({
        bodyHtml: `<p><a href="${wrapped}">${wrapped}</a> und <a href="${wrapped}">Lenis Clip</a> und <a href="https://wanders.example/" data-uwu-safelink="evil.example">ok</a></p>`,
      }),
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const links = [...doc.querySelectorAll("a")];
    expect(links.map((link) => link.textContent)).toEqual(["https://wanders.example/clip?v=2", "Lenis Clip", "ok"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://wanders.example/clip?v=2",
      "https://wanders.example/clip?v=2",
      "https://wanders.example/",
    ]);
    // A mail can't set the marker itself.
    expect(links.map((link) => link.getAttribute("data-uwu-safelink"))).toEqual([
      "eur01.safelinks.protection.outlook.com",
      "eur01.safelinks.protection.outlook.com",
      null,
    ]);
  });

  it("keep the text unwrapped where only the text is a Safe Link", () => {
    const html = readableBody(message({ bodyHtml: `<a href="https://other.example/">${wrapped}</a>` }));
    const link = new DOMParser().parseFromString(html, "text/html").querySelector("a")!;
    expect(link.textContent).toBe("https://wanders.example/clip?v=2");
    expect(link.getAttribute("href")).toBe("https://other.example/");
    expect(link.hasAttribute("data-uwu-safelink")).toBe(false);
  });

  it("leave a Teams join link the reader can find", () => {
    const join = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d";
    const safe = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent(join)}&amp;data=05`;
    expect(teamsMeetingLink(readableBody(message({ bodyHtml: `<a href="${safe}">Join</a>` })))).toBe(join);
  });

  it("in plain-text mail too", () => {
    const html = readableBody(message({ bodyText: `Hier: ${wrapped}\nBis bald` }));
    const link = new DOMParser().parseFromString(html, "text/html").querySelector("a")!;
    expect(link.textContent).toBe("https://wanders.example/clip?v=2");
    expect(link.getAttribute("href")).toBe("https://wanders.example/clip?v=2");
    expect(link.getAttribute("data-uwu-safelink")).toBe("eur01.safelinks.protection.outlook.com");
    const plain = readableBody(message({ bodyText: "Siehe https://wanders.example/a?b=1&c=2" }));
    expect(plain).toContain(
      '<a href="https://wanders.example/a?b=1&amp;c=2">https://wanders.example/a?b=1&amp;c=2</a>',
    );
  });
});

describe("buildDocument", () => {
  it("keeps a newsletter's leading <style> block", () => {
    const doc = buildDocument(
      message({ bodyHtml: '<style>.cta { color: #ff0000 }</style><table><tr><td class="cta">Buy</td></tr></table>' }),
      false,
      "light",
    );
    expect(doc).toContain(".cta { color: #ff0000 }");
    expect(doc).toContain(`<div id="${ROOT_ID}">`);
  });

  it("strips scripts and handlers", () => {
    const doc = buildDocument(
      message({ bodyHtml: '<p onclick="steal()">Hi</p><script>steal()</script>' }),
      false,
      "light",
    );
    expect(doc).not.toContain("steal");
  });

  it("keeps no link the reader can't catch: MathML carries none (WebKit follows its href)", () => {
    const html = readableBody(
      message({ bodyHtml: '<p>E = <math><mi href="https://elsewhere.example/">mc</mi></math></p>' }),
    );
    expect(html).not.toContain("elsewhere.example");
    expect(html).toContain("<math");
    expect(html).toContain("mc");
  });

  it("does not force app typography onto HTML mail", () => {
    const doc = buildDocument(message({ bodyHtml: "<p>Hi</p>" }), false, "light");
    expect(doc).not.toContain("overflow-wrap:anywhere");
    expect(doc).not.toContain("font:15px");
  });

  describe("fonts", () => {
    const faces = '@font-face{font-family:"uwu-mail-font";src:url(data:font/woff2;base64,AAAA) format("woff2")}';
    const fonts = { font: "uwu", senderFonts: "replace", faces } as const;
    const build = (patch: Partial<Message>, chosen: Parameters<typeof buildDocument>[7] = fonts) =>
      buildDocument(message(patch), false, "light", new Map(), null, [], false, chosen);

    it("gives HTML mail without a font of its own ours instead of the engine's Times", () => {
      const doc = build({ bodyHtml: "<p>Hi</p>" });
      expect(doc).toContain(faces);
      expect(doc).toMatch(/body\{[^}]*font-family:var\(--uwu-font\)/);
      expect(doc).toContain('--uwu-font:"uwu-mail-font", system-ui');
    });

    it("replaces serif fonts, or keeps them when asked", () => {
      const html = '<p style="font-family: Georgia, serif">Hi</p><p style="font-family: Arial, sans-serif">Ho</p>';
      const replaced = build({ bodyHtml: html });
      expect(replaced).toContain("font-family: var(--uwu-serif, Georgia), var(--uwu-serif, serif)");
      expect(replaced).toContain("font-family: Arial, var(--uwu-sans, sans-serif)");
      expect(replaced).toContain("--uwu-serif:var(--uwu-font)");
      const kept = build({ bodyHtml: html }, { ...fonts, senderFonts: "keep" });
      expect(kept).not.toContain("--uwu-serif:");
      expect(kept).not.toContain("--uwu-sans:");
      // ...but a mail without a font still doesn't end up in Times
      expect(kept).toMatch(/body\{[^}]*font-family:var\(--uwu-font\)/);
    });

    it("rewrites style blocks, never monospace", () => {
      const doc = build({
        bodyHtml:
          "<style>td{font-family:'Times New Roman'} pre{font-family:Consolas,monospace}</style><table><tr><td>x</td></tr></table>",
      });
      expect(doc).toContain("td{font-family:var(--uwu-serif, 'Times New Roman'), var(--uwu-font)}");
      expect(doc).toContain("pre{font-family:Consolas,monospace}");
    });

    it("sets plain text in the chosen font", () => {
      expect(build({ bodyText: "Hi :3" })).toContain("font:15px/1.6 var(--uwu-font)");
    });

    it("shows the system font while the chosen one still loads", () => {
      const doc = build({ bodyText: "Hi" }, { ...fonts, faces: "" });
      expect(doc).not.toContain("@font-face");
      expect(doc).toContain("--uwu-font:system-ui");
    });

    it("sanitizes the same way whatever the setting, so found dates keep their places", () => {
      const mail = message({ bodyHtml: '<p style="font-family:Georgia">Termin am 3.10.</p>' });
      expect(readableBody(mail)).toContain("var(--uwu-serif, Georgia)");
    });
  });

  it("blocks remote images until allowed", () => {
    const blocked = buildDocument(message({ bodyHtml: "<p>Hi</p>" }), false, "light");
    const allowed = buildDocument(message({ bodyHtml: "<p>Hi</p>" }), true, "light");
    expect(blocked).toContain("img-src data: cid: blob:;");
    expect(allowed).toContain("https:");
  });

  it("turns links in plain text into anchors", () => {
    const doc = buildDocument(message({ bodyText: "Look at https://uwumail.example/docs." }), false, "dark");
    expect(doc).toContain('<a href="https://uwumail.example/docs">https://uwumail.example/docs</a>.');
  });

  // Regression: a frame whose document says "light" inside a dark app gets an
  // opaque white canvas, which made plain text unreadable in dark mode.
  it("gives dark plain text a matching color scheme", () => {
    expect(buildDocument(message({ bodyText: "Hi" }), false, "dark")).toContain(":root{color-scheme:dark;");
  });
});

describe("remote pictures in the reader", () => {
  const proxy = (url: string) => `uwuimg://localhost/picture?account=a1&url=${encodeURIComponent(url)}`;
  /** As it stands in the serialized document. */
  const shown = (url: string) => proxy(url).replace(/&/g, "&amp;");
  const mail = message({
    bodyHtml:
      '<p>Hi</p><img src="https://cdn.example/hero.jpg" width="600" height="300"><img src="cid:logo">' +
      '<div style="background:url(https://cdn.example/bg.png)">x</div>',
  });

  // Regression: a srcdoc frame's load event waits for every picture, so one dead tracking host
  // kept the whole mail hidden until fetching it gave up.
  it("names no remote picture in the document, only placeholders of their size", () => {
    const doc = buildDocument(mail, true, "light", new Map(), proxy, [], true);
    expect(doc).not.toMatch(/ src="uwuimg:/);
    expect(doc).toContain(`data-uwu-src="${shown("https://cdn.example/hero.jpg")}"`);
    expect(doc).toContain("width='600'%20height='300'");
    expect(doc).toContain("data-uwu-pending");
    expect(doc).toContain("@keyframes uwu-shimmer");
    // Backgrounds stay as they were, through the app.
    expect(doc).toContain(shown("https://cdn.example/bg.png"));
    expect(doc).toContain("img-src data: cid: blob: uwuimg: http://uwuimg.localhost;");
  });

  it("keeps the reader's own date marks when pictures load, and none a mail brings (W-41)", () => {
    const dated = message({
      bodyHtml: '<p>Hello <span data-uwu-date="7" data-uwu-src="x">you</span></p><img src="https://cdn.example/a.jpg">',
    });
    const mark = { from: 0, to: 5, index: 0, label: "Termin" };
    const doc = buildDocument(dated, true, "light", new Map(), proxy, [mark], true);
    expect(doc).toContain('data-uwu-date="0"');
    expect(doc).not.toContain('data-uwu-date="7"');
    expect(doc).not.toContain('data-uwu-src="x"');
    expect(readableBody(dated)).not.toContain("data-uwu-");
  });

  it("defers nothing while remote pictures are blocked, or without being asked to", () => {
    const blocked = buildDocument(mail, false, "light", new Map(), proxy, [], true);
    expect(blocked).not.toContain("data-uwu-");
    expect(blocked).toContain('src="https://cdn.example/hero.jpg"');
    const direct = buildDocument(mail, true, "light", new Map(), proxy);
    expect(direct).not.toContain("data-uwu-");
    expect(direct).toContain(`src="${shown("https://cdn.example/hero.jpg")}"`);
  });

  it("prints with the real pictures", () => {
    const labels = { from: "From", to: "To", cc: "Cc", date: "Date" };
    const doc = buildPrintDocument(mail, true, new Map(), labels, "today", proxy);
    expect(doc).toContain(`src="${shown("https://cdn.example/hero.jpg")}"`);
    expect(doc).not.toContain("data-uwu-");
  });
});

describe("frame height", () => {
  // Regression: the frame is as tall as its content, so 100vh grew forever.
  it("turns viewport height units into fixed pixels", () => {
    expect(fixViewportHeightUnits(".hero{min-height:100vh;height:50dvh;width:100vw;margin:-2.5vmin}")).toBe(
      ".hero{min-height:900px;height:450px;width:100vw;margin:-22.5px}",
    );
    expect(buildDocument(message({ bodyHtml: '<div style="min-height:100vh">Hi</div>' }), false, "light")).toContain(
      "min-height:900px",
    );
    expect(fixViewportHeightUnits("a:-.5dvh;b:1.5svh;c:50VMAX;d:.5vh;e:10vhx")).toBe(
      "a:-4.5px;b:13.5px;c:450px;d:4.5px;e:10vhx",
    );
  });

  // Regression (security-audit WM-1): a mail of nothing but digits froze the tab for minutes,
  // because the old pattern could split a run of digits in many ways and tried all of them.
  it("stays fast on a long run of digits", () => {
    const digits = "1".repeat(200_000);
    const started = performance.now();
    expect(fixViewportHeightUnits(digits)).toBe(digits);
    expect(fixViewportHeightUnits(`${digits}vh`)).toMatch(/px$/);
    expect(fixViewportHeightUnits("1.".repeat(100_000))).toBe("1.".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("detects a layout that grows by the same step every frame", () => {
    const history: { time: number; delta: number }[] = [];
    let height = 1000;
    let runaway = false;
    for (let frame = 0; frame < 12 && !runaway; frame += 1) {
      runaway = isRunaway(history, height, height + 554, frame * 16);
      height += 554;
    }
    expect(runaway).toBe(true);
  });

  it("lets images that load one after another grow the mail", () => {
    const history: { time: number; delta: number }[] = [];
    const steps = [220, 180, 400, 220, 90, 300, 180, 220, 410, 160, 240, 200];
    let height = 800;
    const results = steps.map((step, index) => {
      const result = isRunaway(history, height, height + step, index * 16);
      height += step;
      return result;
    });
    expect(results.some(Boolean)).toBe(false);
  });
});

describe("resolveAppearance", () => {
  const html = message({ bodyHtml: "<p>Hi</p>" });
  const text = message({ bodyText: "Hi" });
  const native = message({
    bodyHtml: "<style>@media (prefers-color-scheme: dark) { p { color: #fff } }</style><p>Hi</p>",
  });

  it("shows everything as designed in the light app theme", () => {
    expect(resolveAppearance(html, false, "dark")).toEqual({ kind: "light", why: "app" });
  });

  it("follows the app for plain text unless light was chosen", () => {
    expect(resolveAppearance(text, true, "auto")).toEqual({ kind: "dark", why: "app" });
    expect(resolveAppearance(text, true, "light")).toEqual({ kind: "light", why: "choice" });
  });

  it("uses the mail's own dark mode before recoloring", () => {
    expect(resolveAppearance(native, true, "auto")).toEqual({ kind: "dark", why: "native" });
    expect(buildDocument(native, false, "dark")).toContain("@media (min-width: 0px)");
    expect(buildDocument(native, false, "light")).toContain("@media (max-width: -1px)");
  });

  it("measures simple HTML mail before deciding", () => {
    expect(resolveAppearance(html, true, "auto")).toEqual({ kind: "auto" });
    expect(resolveAppearance(html, true, "dark")).toEqual({ kind: "darken", why: "choice" });
  });
});

describe("embedded images", () => {
  it("show in the reader as the blob URLs of their files", () => {
    const doc = buildDocument(
      message({ bodyHtml: '<img src="cid:logo@shop" alt="Logo">' }),
      false,
      "light",
      new Map([["logo@shop", "blob:logo"]]),
    );
    expect(doc).toContain('src="blob:logo"');
  });
});

describe("buildPrintDocument", () => {
  const labels = { from: "Von", to: "An", cc: "Cc", date: "Datum" };

  it("prints the header and a sanitized body without remote content", () => {
    const doc = buildPrintDocument(
      message({
        subject: "Rechnung <2026>",
        to: [{ name: "Mini", email: "mini@uwumail.example" }],
        bodyHtml: '<p>Hallo</p><script>alert(1)</script><img src="cid:logo@shop">',
      }),
      false,
      new Map([["logo@shop", "blob:logo"]]),
      labels,
      "14. September 2026",
    );
    expect(doc).toContain("<title>Rechnung &#60;2026&#62;</title>");
    expect(doc).toContain("Mini &#60;mini@uwumail.example&#62;");
    expect(doc).toContain('src="blob:logo"');
    expect(doc).not.toContain("<script>");
    expect(doc).toContain("img-src data: blob:;");
  });

  it("does not let the mail's CSS hide or overlay the printed header (W-3)", () => {
    const doc = buildPrintDocument(
      message({
        subject: "Echt",
        to: [{ name: "Mini", email: "mini@uwumail.example" }],
        bodyHtml: "<style>table.head,h1{display:none}</style><h1>Gefälscht</h1><p>Text</p>",
      }),
      false,
      new Map(),
      labels,
      "14. September 2026",
    );
    // The style block that could reach the app's header is gone; the body sits in a contained box.
    expect(doc).not.toContain("display:none");
    expect(doc).not.toContain("<style>table.head");
    expect(doc).toContain("contain:content");
  });

  it("drops every kind of style block from the printed body, content and all", () => {
    const doc = buildPrintDocument(
      message({
        bodyHtml:
          '<STYLE media="print">h1{visibility:hidden}</STYLE><svg><style>table{opacity:0}</style></svg><p style="color:#333">Text</p>',
      }),
      false,
      new Map(),
      labels,
      "14. September 2026",
    );
    expect(doc).not.toContain("visibility:hidden");
    expect(doc).not.toContain("opacity:0");
    expect(doc).toContain('<p style="color:#333">Text</p>');
    // The page's own style block is still there.
    expect(doc.match(/<style>/g)).toHaveLength(1);
  });
});
