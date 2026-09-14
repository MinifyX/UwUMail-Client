import { describe, expect, it } from "vitest";
import type { Message } from "@/backend/types";
import { buildDocument, resolveAppearance, ROOT_ID } from "./MessageBody";

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

  it("does not force app typography onto HTML mail", () => {
    const doc = buildDocument(message({ bodyHtml: "<p>Hi</p>" }), false, "light");
    expect(doc).not.toContain("Manrope");
    expect(doc).not.toContain("overflow-wrap:anywhere");
  });

  it("blocks remote images until allowed", () => {
    const blocked = buildDocument(message({ bodyHtml: "<p>Hi</p>" }), false, "light");
    const allowed = buildDocument(message({ bodyHtml: "<p>Hi</p>" }), true, "light");
    expect(blocked).toContain("img-src data: cid: blob:;");
    expect(allowed).toContain("https:");
  });

  it("turns links in plain text into anchors", () => {
    const doc = buildDocument(message({ bodyText: "Look at https://uwumail.dev/docs." }), false, "dark");
    expect(doc).toContain('<a href="https://uwumail.dev/docs">https://uwumail.dev/docs</a>.');
  });

  // Regression: a frame whose document says "light" inside a dark app gets an
  // opaque white canvas, which made plain text unreadable in dark mode.
  it("gives dark plain text a matching color scheme", () => {
    expect(buildDocument(message({ bodyText: "Hi" }), false, "dark")).toContain(":root{color-scheme:dark}");
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
