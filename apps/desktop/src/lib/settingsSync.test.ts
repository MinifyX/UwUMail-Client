import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/state/settings";
import {
  MAX_VALUE_BYTES,
  applyToSettings,
  diffValues,
  isSyncable,
  mergeWithServer,
  settingsToValues,
  syncableValues,
  type SyncedSettings,
} from "./settingsSync";

const base: SyncedSettings = {
  theme: "system",
  tone: "playful",
  language: "system",
  conversations: true,
  remoteImages: "ask",
  mailAppearance: "auto",
  senderPictures: true,
  undoSendSeconds: 10,
  linkConfirm: true,
  trustedSenders: [],
  senderAppearance: {},
  linkDomains: [],
};

const signature = { email: "mini@uwumail.test", name: "Kurz", html: "<p>Mini</p>", forNew: true, forReplies: false };

describe("keys the server takes", () => {
  it("knows every choice and its values", () => {
    expect(isSyncable("theme", "dark")).toBe(true);
    expect(isSyncable("theme", "sepia")).toBe(false);
    expect(isSyncable("conversations", "on")).toBe(false);
    expect(isSyncable("undoSendSeconds", 20)).toBe(true);
    expect(isSyncable("undoSendSeconds", 15)).toBe(false);
    expect(isSyncable("linkConfirm", false)).toBe(true);
    expect(isSyncable("listDensity", "compact")).toBe(false);
  });

  it("checks list entries like the server", () => {
    expect(isSyncable("trustedSenders:@shop.example", true)).toBe(true);
    expect(isSyncable("trustedSenders:news@shop.example", true)).toBe(true);
    // Domains of mail addresses need a dot; upper case and false are refused.
    expect(isSyncable("trustedSenders:@localhost", true)).toBe(false);
    expect(isSyncable("trustedSenders:News@shop.example", true)).toBe(false);
    expect(isSyncable("trustedSenders:@shop.example", false)).toBe(false);
    expect(isSyncable("trustedSenders:@bücher.example", true)).toBe(true);
    expect(isSyncable("senderAppearance:news@shop.example", "dark")).toBe(true);
    expect(isSyncable("senderAppearance:@shop.example", "dark")).toBe(false);
    expect(isSyncable("senderAppearance:news@shop.example", "auto")).toBe(false);
    // Link hosts may be dotless, but only ASCII.
    expect(isSyncable("linkDomains:intranet", true)).toBe(true);
    expect(isSyncable("linkDomains:xn--bcher-kva.example", true)).toBe(true);
    expect(isSyncable("linkDomains:bücher.example", true)).toBe(false);
    expect(isSyncable("colour", "pink")).toBe(false);
  });

  it("wants signatures whole and in their shape", () => {
    expect(isSyncable("signature:abc-1_x", signature)).toBe(true);
    expect(isSyncable("signature:abc", { ...signature, email: "" })).toBe(true);
    expect(isSyncable("signature:a/b", signature)).toBe(false);
    expect(isSyncable("signature:abc", { ...signature, extra: 1 })).toBe(false);
    expect(isSyncable("signature:abc", { ...signature, email: "nobody" })).toBe(false);
    expect(isSyncable("signature:abc", { ...signature, name: "x".repeat(101) })).toBe(false);
    const missing: Record<string, unknown> = { ...signature };
    delete missing.forReplies;
    expect(isSyncable("signature:abc", missing)).toBe(false);
    expect(isSyncable("signature:abc", { ...signature, html: "x".repeat(MAX_VALUE_BYTES) })).toBe(false);
  });

  it("drops what it doesn't know from the server's copy", () => {
    expect(syncableValues({ theme: "dark", future: 1, "trustedSenders:@x": true })).toEqual({ theme: "dark" });
  });
});

describe("settings as keys", () => {
  it("writes choices as keys and lists as one key per entry", () => {
    const values = settingsToValues({
      ...base,
      theme: "dark",
      trustedSenders: ["@shop.example", "@localhost"],
      senderAppearance: { "news@shop.example": "light" },
      linkDomains: ["uwumail.test"],
    });
    expect(values).toMatchObject({
      theme: "dark",
      undoSendSeconds: 10,
      "trustedSenders:@shop.example": true,
      "senderAppearance:news@shop.example": "light",
      "linkDomains:uwumail.test": true,
    });
    // Nothing the server would refuse, so one odd entry never fails a whole write.
    expect(values).not.toHaveProperty(["trustedSenders:@localhost"]);
  });

  it("covers every synced field of the defaults", () => {
    expect(Object.keys(settingsToValues(DEFAULT_SETTINGS)).sort()).toEqual(
      [
        "conversations",
        "language",
        "linkConfirm",
        "mailAppearance",
        "remoteImages",
        "senderPictures",
        "theme",
        "tone",
        "undoSendSeconds",
      ].sort(),
    );
  });

  it("applies a patch and returns only what changed", () => {
    const current = {
      ...base,
      trustedSenders: ["@a.example", "@localhost"],
      senderAppearance: { "x@a.example": "dark" as const },
    };
    const changed = applyToSettings(current, {
      theme: "dark",
      tone: "playful",
      "trustedSenders:@b.example": true,
      "trustedSenders:@a.example": null,
      "senderAppearance:x@a.example": null,
      "linkDomains:uwumail.test": true,
      "signature:abc": signature,
      language: null,
      colour: "pink",
    });
    expect(changed).toEqual({
      theme: "dark",
      // The entry the server never saw stays.
      trustedSenders: ["@localhost", "@b.example"],
      senderAppearance: {},
      linkDomains: ["uwumail.test"],
    });
  });

  it("diffs into a patch with null for removals", () => {
    expect(diffValues({ theme: "dark", "linkDomains:a": true }, { theme: "light", "linkDomains:b": true })).toEqual({
      theme: "light",
      "linkDomains:b": true,
      "linkDomains:a": null,
    });
    expect(diffValues({ "signature:a": { ...signature } }, { "signature:a": { ...signature } })).toEqual({});
  });
});

describe("merging with the server", () => {
  it("unites lists on the first merge and lets the server's choices win", () => {
    const result = mergeWithServer({
      server: { theme: "dark", "trustedSenders:@server.example": true },
      local: { theme: "light", tone: "neutral", "trustedSenders:@local.example": true },
      pending: {},
      firstSync: true,
    });
    expect(result.apply).toEqual({ theme: "dark", "trustedSenders:@server.example": true });
    // The server had no tone yet, so it gets this device's.
    expect(result.pending).toEqual({ tone: "neutral", "trustedSenders:@local.example": true });
  });

  it("later takes removals from other devices", () => {
    const result = mergeWithServer({
      server: { theme: "dark" },
      local: { theme: "dark", "linkDomains:gone.example": true },
      pending: {},
      firstSync: false,
    });
    expect(result.apply).toEqual({ "linkDomains:gone.example": null });
    expect(result.pending).toEqual({});
  });

  it("keeps changes made here that haven't gone out", () => {
    const result = mergeWithServer({
      server: { theme: "dark", "trustedSenders:@a.example": true },
      local: { theme: "light", "linkDomains:new.example": true },
      pending: { theme: "light", "trustedSenders:@a.example": null, "linkDomains:new.example": true },
      firstSync: false,
    });
    expect(result.apply).toEqual({});
    expect(result.pending).toEqual({
      theme: "light",
      "trustedSenders:@a.example": null,
      "linkDomains:new.example": true,
    });
  });

  it("drops pending changes the server already has", () => {
    const result = mergeWithServer({
      server: { theme: "light" },
      local: { theme: "light" },
      pending: { theme: "light", "linkDomains:x.example": null },
      firstSync: false,
    });
    expect(result.pending).toEqual({});
  });

  it("leaves kept keys alone on both sides", () => {
    const result = mergeWithServer({
      server: { "signature:big": signature },
      local: { "trustedSenders:@refused.example": true },
      pending: {},
      firstSync: false,
      keep: new Set(["signature:big", "trustedSenders:@refused.example"]),
    });
    expect(result).toEqual({ apply: {}, pending: {} });
  });
});
