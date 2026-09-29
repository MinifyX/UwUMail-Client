import { describe, expect, it } from "vitest";
import { appendToOwnText, ownText, replaceOwnText, splitDraft } from "./draftText";

const SIGNATURE = `<div data-uwu-signature="1"><p>-- <br>Mini</p></div>`;
const QUOTE = `<p>On Mon, Leni wrote:</p><blockquote><p>Lunch on Friday?</p></blockquote>`;
const FORWARD = `<p>---------- Forwarded message ---------</p><p>From: shop@example.com</p>`;

describe("the own part of a draft", () => {
  it("ends at the signature, and the quote header goes with the quote", () => {
    const html = `<p>Hi Leni,</p><p>sure!</p>${SIGNATURE}${QUOTE}`;
    const { own, rest } = splitDraft(html);
    expect(own).toBe("<p>Hi Leni,</p><p>sure!</p>");
    expect(rest).toBe(SIGNATURE + QUOTE);
    expect(ownText(html)).toContain("Hi Leni,");
    expect(ownText(html)).not.toContain("Lunch");
    expect(ownText(html)).not.toContain("Mini");
  });

  it("ends at the quote header without a signature", () => {
    const { own, rest } = splitDraft(`<p>Yes.</p>${QUOTE}`);
    expect(own).toBe("<p>Yes.</p>");
    expect(rest).toBe(QUOTE);
  });

  it("ends at a forward's header", () => {
    const { own, rest } = splitDraft(`<p>FYI</p>${FORWARD}`);
    expect(own).toBe("<p>FYI</p>");
    expect(rest).toBe(FORWARD);
  });

  it("is everything in new mail", () => {
    expect(splitDraft("<p>One</p><p>Two</p>")).toEqual({ own: "<p>One</p><p>Two</p>", rest: "" });
  });

  it("keeps plain text between blocks, escaped", () => {
    expect(splitDraft("a <b>&lt;x&gt;</b>").own).toBe("a <b>&lt;x&gt;</b>");
  });
});

describe("putting the assistant's text into a draft", () => {
  it("replaces only the own part; signature and quote stay", () => {
    const html = `<p>draft</p>${SIGNATURE}${QUOTE}`;
    const next = replaceOwnText(html, "Hello Leni,\n\nsee you <then>.\nMini");
    expect(next).toBe(`<p>Hello Leni,</p><p>see you &lt;then&gt;.<br>Mini</p><p><br></p>${SIGNATURE}${QUOTE}`);
  });

  it("adds at the end of the own part", () => {
    const html = `<p>First</p>${SIGNATURE}`;
    expect(appendToOwnText(html, "Second")).toBe(`<p>First</p><p>Second</p><p><br></p>${SIGNATURE}`);
  });

  it("fills an empty own part instead of leaving a gap", () => {
    const html = `<p><br></p>${SIGNATURE}`;
    expect(appendToOwnText(html, "Text")).toBe(`<p>Text</p><p><br></p>${SIGNATURE}`);
  });

  it("works on a draft without anything else", () => {
    expect(replaceOwnText("<p>old</p>", "  new  ")).toBe("<p>new</p>");
  });
});
