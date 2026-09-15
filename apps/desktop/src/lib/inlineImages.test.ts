import { describe, expect, it } from "vitest";
import { normalizeContentId, referencedContentIds, replaceContentIds } from "./inlineImages";

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
});
