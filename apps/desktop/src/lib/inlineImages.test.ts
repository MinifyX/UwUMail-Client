import { describe, expect, it } from "vitest";
import { normalizeContentId, rasterImageType, referencedContentIds, replaceContentIds } from "./inlineImages";

describe("embedded images", () => {
  it("finds the parts a mail's HTML shows", () => {
    const html = `<img src="cid:Logo@Shop.example"><td style="background:url(cid:bg%40shop.example)"><img src='x.png'>`;
    expect([...referencedContentIds(html)]).toEqual(["logo@shop.example", "bg@shop.example"]);
    expect(referencedContentIds(null).size).toBe(0);
  });

  it("points them at the cached files and leaves the rest", () => {
    const urls = new Map([["logo@shop.example", "http://asset.localhost/logo.png"]]);
    expect(replaceContentIds(`<img src="cid:LOGO@shop.example"><img src="cid:missing@x">`, urls)).toBe(
      `<img src="http://asset.localhost/logo.png"><img src="cid:missing@x">`,
    );
  });

  it("compares ids without brackets and case", () => {
    expect(normalizeContentId(" <Img1.ABC@uwumail> ")).toBe("img1.abc@uwumail");
  });

  it("only swaps addresses that load pictures, never link targets (RD-1)", () => {
    const urls = new Map([["x@shop.example", "blob:own/x"]]);
    const html = replaceContentIds(
      `<a href="cid:x@shop.example">a</a><area href="cid:x@shop.example">` +
        `<svg><a href="cid:x@shop.example"><text>b</text></a><image href="cid:x@shop.example"></image></svg>` +
        `<img srcset="cid:x@shop.example 2x"><table><tr><td background="cid:x@shop.example"></td></tr></table>` +
        `<div style="background:url(cid:x@shop.example)">c</div><style>p{background:url('cid:x@shop.example')}</style>`,
      urls,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const link of Array.from(doc.querySelectorAll("a, area"))) {
      expect(link.getAttribute("href")).toBe("cid:x@shop.example");
    }
    expect(doc.querySelector("image")!.getAttribute("href")).toBe("blob:own/x");
    expect(doc.querySelector("img")!.getAttribute("srcset")).toBe("blob:own/x 2x");
    expect(doc.querySelector("td")!.getAttribute("background")).toBe("blob:own/x");
    expect(doc.querySelector("div")!.getAttribute("style")).toContain("url(blob:own/x)");
    expect(doc.querySelector("style")!.textContent).toContain("url('blob:own/x')");
  });

  it("recognizes pictures by their bytes and nothing else", () => {
    const bytes = (...parts: (string | number[])[]) =>
      new Uint8Array(
        parts.flatMap((part) => (typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part)),
      );
    expect(rasterImageType(bytes([0x89], "PNG\r\n\x1a\n", "rest"))).toBe("image/png");
    expect(rasterImageType(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(rasterImageType(bytes("GIF89a", [1, 0, 1, 0]))).toBe("image/gif");
    expect(rasterImageType(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 "))).toBe("image/webp");
    expect(rasterImageType(bytes([0, 0, 0, 28], "ftypavif"))).toBe("image/avif");
    expect(rasterImageType(bytes("<!doctype html><script>x()</script>"))).toBeNull();
    expect(rasterImageType(bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(rasterImageType(bytes("%PDF-1.7"))).toBeNull();
    expect(rasterImageType(new Uint8Array())).toBeNull();
  });
});
