import { describe, expect, it } from "vitest";
import { checkLink, needsConfirmation, urlParts, visibleText, type LinkCheck } from "./links";

const rlo = String.fromCodePoint(0x202e);
const zwsp = String.fromCodePoint(0x200b);
const newline = String.fromCharCode(10);

describe("link display", () => {
  it("shows invisible and direction characters instead of obeying them", () => {
    expect(visibleText(`invoice${rlo}fdp.exe`)).toBe("invoice<U+202E>fdp.exe");
    expect(visibleText(`a${zwsp}b${newline}c`)).toBe("a<U+200B>b<U+000A>c");
    expect(visibleText("https://example.org/ok")).toBe("https://example.org/ok");
  });

  it("splits an address so the registrable domain stands out", () => {
    expect(urlParts("https://mail.shop.example.co.uk:8443/a/b?c=d#e")).toEqual({
      scheme: "https://",
      userinfo: "",
      subdomain: "mail.shop.",
      domain: "example.co.uk",
      port: ":8443",
      rest: "/a/b?c=d#e",
    });
    expect(urlParts("https://bank.example:secret@evil.example/")).toMatchObject({
      userinfo: "bank.example:…@",
      domain: "evil.example",
    });
    expect(urlParts(`https://example.org/${rlo}x`)?.rest).toBe("/%E2%80%AEx");
    expect(urlParts("mailto:a@example.org")).toBeNull();
    expect(urlParts("nonsense")).toBeNull();
  });
});

describe("checkLink", () => {
  it("only checks web and mail links", () => {
    expect(checkLink("javascript:alert(1)", "")).toBeNull();
    expect(checkLink("file:///etc/passwd", "")).toBeNull();
    expect(checkLink("#top", "")).toBeNull();
  });

  it("offers to remember the domain of an ordinary https link", () => {
    expect(checkLink(" https://news.shop.example/deal ", "Zum Angebot")).toMatchObject({
      href: "https://news.shop.example/deal",
      kind: "web",
      host: "news.shop.example",
      insecure: false,
      misleading: null,
      rememberable: "shop.example",
    });
  });

  it("never offers it for disguised, http, international, user-name, IP or shared hosts", () => {
    expect(checkLink("https://evil.example/", "www.bank.example")?.rememberable).toBeNull();
    expect(checkLink("http://shop.example/", "")).toMatchObject({ insecure: true, rememberable: null });
    expect(checkLink("https://xn--pypal-4ve.example/konto", "")).toMatchObject({
      unicodeHost: "pаypal.example",
      lookalike: true,
      rememberable: null,
    });
    expect(checkLink("https://www.xn--mnchen-3ya.example/", "")).toMatchObject({
      unicodeHost: "www.münchen.example",
      lookalike: false,
      rememberable: null,
    });
    expect(checkLink("https://bank.example@evil.example/", "")).toMatchObject({ userinfo: true, rememberable: null });
    expect(checkLink("https://192.0.2.10/login", "")?.rememberable).toBeNull();
    expect(checkLink("https://bucket.s3.amazonaws.com/x", "")?.rememberable).toBeNull();
  });

  it("reads mail links and their recipients", () => {
    const check = checkLink("mailto:hallo@cafe.example?cc=team@cafe.example&subject=Tisch%20reservieren", "");
    expect(check?.kind).toBe("mail");
    expect(check?.rememberable).toBeNull();
    expect(check?.mailto).toEqual({
      to: [{ email: "hallo@cafe.example" }],
      cc: [{ email: "team@cafe.example" }],
      bcc: [],
      subject: "Tisch reservieren",
      body: "",
    });
  });

  it("carries what a redirect link reveals", () => {
    expect(checkLink("https://www.google.com/url?q=https://end.example/", "")?.redirect?.target).toBe(
      "https://end.example/",
    );
  });
});

describe("needsConfirmation", () => {
  const web = checkLink("https://shop.example/", "Shop") as LinkCheck;
  const disguised = checkLink("https://evil.example/", "shop.example") as LinkCheck;
  const insecure = checkLink("http://shop.example/", "") as LinkCheck;
  const mail = checkLink("mailto:a@shop.example", "") as LinkCheck;

  it("asks by default", () => {
    expect(needsConfirmation(web, { confirm: true, domains: [] })).toBe(true);
    expect(needsConfirmation(mail, { confirm: true, domains: ["shop.example"] })).toBe(true);
  });

  it("skips remembered domains, but only for links that could be remembered", () => {
    expect(needsConfirmation(web, { confirm: true, domains: ["shop.example"] })).toBe(false);
    expect(needsConfirmation(insecure, { confirm: true, domains: ["shop.example"] })).toBe(true);
    expect(needsConfirmation(web, { confirm: true, domains: ["other.example"] })).toBe(true);
  });

  it("opens right away when asking is off", () => {
    expect(needsConfirmation(web, { confirm: false, domains: [] })).toBe(false);
    expect(needsConfirmation(insecure, { confirm: false, domains: [] })).toBe(false);
    expect(needsConfirmation(mail, { confirm: false, domains: [] })).toBe(false);
  });

  it("always asks for disguised links", () => {
    expect(needsConfirmation(disguised, { confirm: false, domains: ["evil.example"] })).toBe(true);
    expect(needsConfirmation(disguised, { confirm: true, domains: ["evil.example"] })).toBe(true);
    const lookalike = checkLink("https://xn--pypal-4ve.example/konto", "") as LinkCheck;
    const userinfo = checkLink("https://bank.example@evil.example/", "") as LinkCheck;
    expect(needsConfirmation(lookalike, { confirm: false, domains: [] })).toBe(true);
    expect(needsConfirmation(userinfo, { confirm: false, domains: ["evil.example"] })).toBe(true);
  });

  it("asks through a remembered domain when the link forwards elsewhere", () => {
    const forwarding = checkLink("https://shop.example/out?url=https%3A%2F%2Fevil.example%2F", "") as LinkCheck;
    expect(forwarding.redirect?.target).toBe("https://evil.example/");
    expect(forwarding.rememberable).toBeNull();
    expect(needsConfirmation(forwarding, { confirm: true, domains: ["shop.example"] })).toBe(true);
    const within = checkLink("https://shop.example/login?next=https%3A%2F%2Fshop.example%2Fcart", "") as LinkCheck;
    expect(within.redirect).toBeNull();
    expect(needsConfirmation(within, { confirm: true, domains: ["shop.example"] })).toBe(false);
  });
});
