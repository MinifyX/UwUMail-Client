import { describe, expect, it } from "vitest";
import { htmlToPlainText, isSafeLinkTarget, quotableHtml } from "./safeHtml";

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
