import { describe, expect, it } from "vitest";
import { detectRedirect, embeddedUrl } from "./redirects";

const target = (href: string) => detectRedirect(href)?.target ?? null;

describe("detectRedirect", () => {
  it("leaves plain links alone", () => {
    expect(detectRedirect("https://shop.example/sets/bubblegum")).toBeNull();
    expect(detectRedirect("https://shop.example/search?q=keycaps")).toBeNull();
    expect(detectRedirect("mailto:someone@example.org")).toBeNull();
  });

  it("reads Outlook SafeLinks", () => {
    const href =
      "https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwanders.example%2Fclip%3Fv%3D2&data=05%7C01&reserved=0";
    expect(detectRedirect(href)).toEqual({
      via: ["eur01.safelinks.protection.outlook.com"],
      target: "https://wanders.example/clip?v=2",
      hidden: null,
    });
  });

  it("reads Google, Facebook, LinkedIn and Slack redirects", () => {
    expect(target("https://www.google.com/url?q=https://mood.example/a&sa=D")).toBe("https://mood.example/a");
    expect(target("https://www.google.de/url?url=https%3A%2F%2Fmood.example%2Fb")).toBe("https://mood.example/b");
    expect(target("https://l.facebook.com/l.php?u=https%3A%2F%2Fnews.example%2Fpost&h=AT0")).toBe(
      "https://news.example/post",
    );
    expect(target("https://www.linkedin.com/redir/redirect?url=https%3A%2F%2Fjobs.example%2F1")).toBe(
      "https://jobs.example/1",
    );
    expect(target("https://slack-redir.net/link?url=https%3A%2F%2Fdocs.example")).toBe("https://docs.example/");
  });

  it("reads the common parameter names, in any case", () => {
    for (const name of ["target", "dest", "destination", "redirect", "redirect_uri", "goto", "link", "r", "to"]) {
      expect(target(`https://go.tracker.example/c?${name}=https%3A%2F%2Fend.example%2F`)).toBe("https://end.example/");
    }
    expect(target("https://go.tracker.example/c?URL=https://end.example/x")).toBe("https://end.example/x");
  });

  it("decodes doubly encoded and base64 destinations", () => {
    expect(target("https://go.tracker.example/c?u=https%253A%252F%252Fend.example%252Fpath")).toBe(
      "https://end.example/path",
    );
    expect(target("https://go.tracker.example/c?r=aHR0cHM6Ly9iZWlzcGllbC5leGFtcGxlL3BmYWQ_YT0x")).toBe(
      "https://beispiel.example/pfad?a=1",
    );
  });

  it("ignores a site sending visitors on within itself", () => {
    expect(detectRedirect("https://shop.example/login?redirect=https://www.shop.example/account")).toBeNull();
  });

  it("reads Proofpoint URL Defense v2 and v3", () => {
    expect(
      target("https://urldefense.proofpoint.com/v2/url?u=https-3A__intranet.example_path-3Fa-3D1&d=DwMF&c=x"),
    ).toBe("https://intranet.example/path?a=1");
    expect(target("https://urldefense.com/v3/__https://mood.example/playlist__;!!AbC!xyz$")).toBe(
      "https://mood.example/playlist",
    );
    // A `*` stands for a character listed, base64, after `__;`: here a "+".
    expect(target("https://urldefense.com/v3/__https://mood.example/a*b__;Kw!!AbC!xyz$")).toBe(
      "https://mood.example/a+b",
    );
    // `**X` stands for a run of characters; "A" means two.
    expect(target("https://urldefense.com/v3/__https://mood.example/a**Ab__;KyY!!AbC!xyz$")).toBe(
      "https://mood.example/a+&b",
    );
  });

  it("names services that hide the destination", () => {
    expect(detectRedirect("https://pixelparts.us1.list-manage.com/track/click?u=abc&id=def")).toEqual({
      via: [],
      target: null,
      hidden: { service: "tracking", host: "pixelparts.us1.list-manage.com" },
    });
    expect(detectRedirect("https://u123.ct.sendgrid.net/ls/click?upn=xyz")?.hidden?.service).toBe("tracking");
    expect(detectRedirect("https://links.shop.example/ls/click?upn=xyz")?.hidden?.service).toBe("tracking");
    expect(detectRedirect("https://d1abc.na1.hubspotlinks.com/Ctc/abc")?.hidden?.service).toBe("tracking");
    expect(detectRedirect("https://protect-eu.mimecast.com/s/abcdef?domain=end.example")?.hidden?.service).toBe(
      "service",
    );
    expect(detectRedirect("https://bit.ly/3abcdef")?.hidden).toEqual({ service: "service", host: "bit.ly" });
    expect(detectRedirect("https://urldefense.com/v3/garbage")?.hidden?.service).toBe("service");
  });

  it("unwraps nested wrappers up to three levels", () => {
    const inner = "https://urldefense.com/v3/__https://mood.example/playlist__;!!AbC!xyz$";
    const google = `https://www.google.com/url?q=${encodeURIComponent(inner)}`;
    expect(detectRedirect(google)).toEqual({
      via: ["www.google.com", "urldefense.com"],
      target: "https://mood.example/playlist",
      hidden: null,
    });
    const tracked = `https://eur01.safelinks.protection.outlook.com/?url=${encodeURIComponent("https://x.list-manage.com/track/click?u=1")}`;
    expect(detectRedirect(tracked)).toEqual({
      via: ["eur01.safelinks.protection.outlook.com"],
      target: "https://x.list-manage.com/track/click?u=1",
      hidden: { service: "tracking", host: "x.list-manage.com" },
    });
    let deep = "https://end.example/";
    for (let level = 0; level < 5; level++)
      deep = `https://w${level}.wrap${level}.example/?url=${encodeURIComponent(deep)}`;
    const result = detectRedirect(deep)!;
    expect(result.via).toHaveLength(3);
    expect(result.target).toMatch(/^https:\/\/w1\.wrap1\.example\//);
  });

  it("survives garbage", () => {
    expect(detectRedirect("")).toBeNull();
    expect(detectRedirect("not a url")).toBeNull();
    expect(detectRedirect("javascript:alert(1)")).toBeNull();
    expect(detectRedirect("https://go.tracker.example/c?url=%E0%A4%A")).toBeNull();
    expect(detectRedirect("https://go.tracker.example/c?url=javascript:alert(1)")).toBeNull();
    expect(detectRedirect("https://go.tracker.example/c?url=https%3A%2F%2F")).toBeNull();
    expect(detectRedirect("https://go.tracker.example/c?r=aHR0cHM6Ly9!!!")).toBeNull();
    expect(detectRedirect("https://urldefense.proofpoint.com/v2/url?u=garbage-2")?.hidden?.service).toBe("service");
  });

  it("keeps bidi and invisible characters out of the host and encodes them in the path", () => {
    const rlo = String.fromCodePoint(0x202e);
    const sneaky = `https://go.tracker.example/c?url=${encodeURIComponent(`https://end.example/${rlo}gpj.exe`)}`;
    const result = target(sneaky)!;
    expect(new URL(result).hostname).toBe("end.example");
    expect(result).not.toContain(rlo);
    expect(
      detectRedirect(`https://go.tracker.example/c?url=${encodeURIComponent(`https://ex${rlo}ample.org/`)}`),
    ).toBeNull();
  });
});

describe("embeddedUrl", () => {
  it("only accepts absolute web addresses", () => {
    expect(embeddedUrl("https://end.example/")?.href).toBe("https://end.example/");
    expect(embeddedUrl("/relative/path")).toBeNull();
    expect(embeddedUrl("ftp://files.example/")).toBeNull();
    expect(embeddedUrl("aHR0cDovL2VuZC5leGFtcGxl")?.href).toBe("http://end.example/");
  });
});
