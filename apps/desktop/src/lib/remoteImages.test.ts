import { describe, expect, it } from "vitest";
import { proxyCss, proxyRemoteImages } from "./remoteImages";

const proxy = (url: string) => `/jmap/image/a1?url=${encodeURIComponent(url)}`;
const through = (url: string) => proxy(url).replaceAll("&", "&amp;");

describe("proxyRemoteImages", () => {
  it("sends every kind of remote picture through the server", () => {
    const html = [
      '<img src="https://cdn.example/a.png" srcset="https://cdn.example/a.png 1x, https://cdn.example/a@2x.png 2x">',
      '<table background="http://old.example/bg.gif"><tr><td style="background-image:url(\'https://cdn.example/b.png\')">x</td></tr></table>',
      '<video poster="https://cdn.example/poster.jpg"></video>',
      "<style>.hero{background:url(https://cdn.example/hero.jpg) no-repeat}</style>",
    ].join("");
    const out = proxyRemoteImages(html, proxy);
    for (const url of [
      "https://cdn.example/a.png",
      "https://cdn.example/a@2x.png",
      "http://old.example/bg.gif",
      "https://cdn.example/b.png",
      "https://cdn.example/poster.jpg",
      "https://cdn.example/hero.jpg",
    ]) {
      expect(out).toContain(encodeURIComponent(url));
    }
    expect(out).not.toMatch(/(src|srcset|background|poster)="https?:/);
    expect(out).not.toMatch(/url\(["']?https?:/);
    expect(out).toContain(" 2x");
  });

  it("leaves embedded pictures and links alone", () => {
    const html = '<a href="https://shop.example/"><img src="cid:logo@shop"></a><img src="data:image/gif;base64,R0lG">';
    const out = proxyRemoteImages(html, proxy);
    expect(out).toContain('href="https://shop.example/"');
    expect(out).toContain('src="cid:logo@shop"');
    expect(out).toContain('src="data:image/gif;base64,R0lG"');
  });

  it("builds addresses the frame can use as they are", () => {
    const out = proxyRemoteImages('<img src="https://cdn.example/a.png?w=1&h=2">', proxy);
    expect(out).toContain(`src="${through("https://cdn.example/a.png?w=1&h=2")}"`);
  });
});

describe("proxyCss", () => {
  it("rewrites quoted and bare url()s, and nothing else", () => {
    const css = `a{background:url("https://x.example/1.png")} b{background:url('http://x.example/2.png')} c{background:url(https://x.example/3.png)} d{background:url(cid:inline)}`;
    const out = proxyCss(css, proxy);
    expect(out).toContain(`url("${proxy("https://x.example/1.png")}")`);
    expect(out).toContain(`url("${proxy("http://x.example/2.png")}")`);
    expect(out).toContain(`url("${proxy("https://x.example/3.png")}")`);
    expect(out).toContain("url(cid:inline)");
    expect(proxyCss("a{background:url( https://x.example/4.png )}", proxy)).toContain(
      `url("${proxy("https://x.example/4.png")}")`,
    );
  });

  // Regression: a style made of `url(url(url(…` or of `url(` and a long run of spaces backtracked
  // for minutes, once remote pictures were allowed for the mail.
  it("stays fast on CSS built to make it backtrack", () => {
    const started = performance.now();
    const nested = "url(".repeat(50_000);
    expect(proxyCss(nested, proxy)).toBe(nested);
    const spaces = `url(${" ".repeat(200_000)}x`;
    expect(proxyCss(spaces, proxy)).toBe(spaces);
    const quotes = 'url("'.repeat(50_000);
    expect(proxyCss(quotes, proxy)).toBe(quotes);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
