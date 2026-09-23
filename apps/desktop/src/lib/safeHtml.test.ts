import { describe, expect, it } from "vitest";
import { htmlToPlainText, isEmbeddedSource, isSafeLinkTarget, quotableHtml } from "./safeHtml";

describe("quotableHtml", () => {
  it("drops styles (inline too), remote images and scripts but keeps the text", () => {
    const html = `<style>body{display:none}</style>
      <p class="x" style="color:red">Hallo <b>Mini</b></p>
      <img src="https://tracker.example/pixel.gif">
      <div style="background:url(https://tracker.example/bg.png)">Hintergrund</div>
      <p style="position:fixed;inset:0;width:100%;height:100%">Overlay</p>
      <img src="data:image/png;base64,AAAA" alt="inline">
      <a href="javascript:alert(1)">Klick</a>
      <a href="https://uwumail.dev">Web</a>
      <script>alert(1)</script><svg onload="alert(1)"></svg>`;
    const cleaned = quotableHtml(html);
    // Inline styles are dropped too: quoted mail renders in the app page and must not restyle it.
    expect(cleaned).not.toMatch(/<style|tracker\.example|<script|<svg|javascript:|class=|style=/i);
    expect(cleaned).toContain("Hallo <b>Mini</b>");
    expect(cleaned).toContain("data:image/png");
    expect(cleaned).toContain('href="https://uwumail.dev"');
    expect(cleaned).toContain("Hintergrund");
    expect(cleaned).toContain("Overlay");
  });

  // security-audit C-5 (the webmail's W-22): addresses the WebView resolves to another server
  // although they don't start with "http" or "//". The app page allows http: and https: pictures.
  it.each([
    ["backslashes", '<img src="https:\\\\tracker.example/a.gif">'],
    ["a scheme-relative backslash", '<img src="\\\\tracker.example/b.gif">'],
    ["a slash and a backslash", '<img src="/\\tracker.example/c.gif">'],
    ["http without slashes", '<img src="http:tracker.example/d.gif">'],
    ["a leading control character", '<img src="&#1;https://tracker.example/e.gif">'],
    ["a tab inside the scheme", '<img src="h&#9;ttps://tracker.example/f.gif">'],
    ["a line break inside the scheme", '<img src="ht&#10;tps://tracker.example/g.gif">'],
    ["a relative address", '<img src="/assets/something.png">'],
    ["a table background", '<table background="https:\\\\tracker.example/h.gif"><tr><td>x</td></tr></table>'],
    ["a cell background", '<table><tr><td background="//tracker.example/i.gif">x</td></tr></table>'],
  ])("loads nothing from %s", (_, html) => {
    const cleaned = quotableHtml(html);
    expect(cleaned).not.toMatch(/tracker\.example|\/assets\//);
    expect(cleaned).not.toMatch(/<img|background=/i);
  });

  it("keeps pictures that carry their content or point into the mail", () => {
    const cleaned = quotableHtml('<img src="data:image/png;base64,AAAA" alt="a"><img src="cid:logo@mail" alt="b">');
    expect(cleaned).toContain('src="data:image/png;base64,AAAA"');
    expect(cleaned).toContain('src="cid:logo@mail"');
  });
});

describe("isEmbeddedSource", () => {
  it("reads the scheme the way a browser does", () => {
    expect(isEmbeddedSource(" data:image/gif;base64,AA")).toBe(true);
    expect(isEmbeddedSource("\u0001cid:x")).toBe(true);
    expect(isEmbeddedSource("d\ta\nta:image/png;base64,AA")).toBe(true);
    expect(isEmbeddedSource("https://tracker.example/p.gif")).toBe(false);
    expect(isEmbeddedSource("\\\\tracker.example/p.gif")).toBe(false);
    expect(isEmbeddedSource("pixel.gif")).toBe(false);
    expect(isEmbeddedSource("")).toBe(false);
  });
});

describe("htmlToPlainText", () => {
  it("keeps line breaks and never loads images", () => {
    expect(htmlToPlainText('<p>Eins</p><p>Zwei<br>Drei</p><img src="https://x.example/a.png">')).toBe(
      "Eins\n\nZwei\nDrei",
    );
  });
});

describe("isSafeLinkTarget", () => {
  it("allows web and mail links only", () => {
    expect(isSafeLinkTarget("https://uwumail.dev")).toBe(true);
    expect(isSafeLinkTarget("mailto:leni@example.com")).toBe(true);
    expect(isSafeLinkTarget(" javascript:alert(1)")).toBe(false);
    expect(isSafeLinkTarget("file:///C:/Windows")).toBe(false);
  });
});
