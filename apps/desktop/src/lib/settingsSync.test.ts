import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/state/settings";
import {
  MAX_VALUE_BYTES,
  applyToSettings,
  diffValues,
  folderRefId,
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
  darkImages: true,
  senderPictures: true,
  undoSendSeconds: 10,
  linkConfirm: true,
  assistCurrency: "EUR",
  assistRefineEvents: false,
  detectEvents: true,
  nyuAnimations: "on",
  trustedSenders: [],
  senderAppearance: {},
  linkDomains: [],
  unifiedHidden: [],
  unifiedFolders: [],
  accountsOrder: [],
  favoriteFolders: [],
  hiddenFolders: [],
  attachmentReminder: true,
  templates: {},
  notifyMuted: [],
  quietHours: { enabled: false, from: "22:00", to: "07:00", days: [0, 1, 2, 3, 4, 5, 6] },
  snoozes: {},
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
    expect(isSyncable("darkImages", "yes")).toBe(false);
    expect(isSyncable("listDensity", "compact")).toBe(false);
    expect(isSyncable("assist.refineEvents", true)).toBe(true);
    expect(isSyncable("assist.refineEvents", "on")).toBe(false);
    expect(isSyncable("nyu.animations", "reduced")).toBe(true);
    expect(isSyncable("nyu.animations", "wild")).toBe(false);
    expect(isSyncable("assistRefineEvents", true)).toBe(false);
  });

  it("takes names every object inherits for nothing", () => {
    // What the server sends is parsed JSON: "__proto__" arrives as a key of its own.
    const values = JSON.parse(
      '{"__proto__":{"theme":"dark"},"constructor":"x","toString":true,"hasOwnProperty":1,"theme":"light"}',
    ) as Record<string, unknown>;
    expect(() => syncableValues(values)).not.toThrow();
    expect(syncableValues(values)).toEqual({ theme: "light" });
    expect(isSyncable("constructor", "x")).toBe(false);
    expect(applyToSettings(base, values)).toEqual({ theme: "light" });
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
        "assist.currency",
        "assist.refineEvents",
        "compose.attachmentReminder",
        "conversations",
        "darkImages",
        "language",
        "linkConfirm",
        "mail.detectEvents",
        "mailAppearance",
        "nyu.animations",
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

  it("maps a choice with a key of its own onto its setting", () => {
    expect(settingsToValues({ ...base, assistRefineEvents: true })).toMatchObject({ "assist.refineEvents": true });
    expect(applyToSettings(base, { "assist.refineEvents": true })).toEqual({ assistRefineEvents: true });
    expect(applyToSettings(base, { "assist.refineEvents": false })).toEqual({});
    expect(applyToSettings(base, { "nyu.animations": "off" })).toEqual({ nyuAnimations: "off" });
    expect(settingsToValues({ ...base, nyuAnimations: "reduced" })).toMatchObject({ "nyu.animations": "reduced" });
  });

  it("keeps finding dates in mail under its namespaced key", () => {
    expect(isSyncable("mail.detectEvents", false)).toBe(true);
    expect(isSyncable("mail.detectEvents", "off")).toBe(false);
    expect(isSyncable("detectEvents", false)).toBe(false);
    expect(settingsToValues({ ...base, detectEvents: false })["mail.detectEvents"]).toBe(false);
    expect(settingsToValues(base)).not.toHaveProperty("detectEvents");
    expect(applyToSettings(base, { "mail.detectEvents": false })).toEqual({ detectEvents: false });
    expect(applyToSettings(base, { detectEvents: false })).toEqual({});
  });

  it("syncs the attachment reminder under the composer's namespace", () => {
    expect(settingsToValues(base)["compose.attachmentReminder"]).toBe(true);
    expect(isSyncable("compose.attachmentReminder", "yes")).toBe(false);
    expect(applyToSettings(base, { "compose.attachmentReminder": false })).toEqual({ attachmentReminder: false });
  });

  it("syncs templates one key each and checks their shape", () => {
    const template = { name: "Thanks", subject: "", html: "<p>Hi {firstName}</p>" };
    expect(settingsToValues({ ...base, templates: { "aB3_-xYz0123456Q": template } })).toMatchObject({
      "template:aB3_-xYz0123456Q": template,
    });
    expect(isSyncable("template:abc", template)).toBe(true);
    expect(isSyncable("template:a/b", template)).toBe(false);
    expect(isSyncable("template:abc", { ...template, name: "" })).toBe(false);
    expect(isSyncable("template:abc", { ...template, name: "x".repeat(101) })).toBe(false);
    expect(isSyncable("template:abc", { ...template, subject: "a\nb" })).toBe(false);
    expect(isSyncable("template:abc", { ...template, subject: "s".repeat(999) })).toBe(false);
    expect(isSyncable("template:abc", { ...template, extra: 1 })).toBe(false);
    expect(isSyncable("template:abc", { ...template, html: "x".repeat(MAX_VALUE_BYTES) })).toBe(false);
    const current = { ...base, templates: { old: template, keep: template } };
    expect(applyToSettings(current, { "template:old": null, "template:new": template })).toEqual({
      templates: { keep: template, new: template },
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

describe("arrangement of mailboxes and folders", () => {
  const inbox = { account: "mini@uwumail.test", folder: "INBOX" };
  const projects = { account: "mini@uwumail.test", folder: "Projekte/Ünïcode" };

  it("names folders by the start of a SHA-256 of address and path", () => {
    expect(folderRefId(inbox)).toBe("312f4066a41e0e45");
    expect(folderRefId(projects)).toBe("256ba3c7a0ede822");
    // Longer than one block of the hash.
    expect(folderRefId({ account: inbox.account, folder: "Archiv/".repeat(20) })).toBe("6c14943694dd13fa");
  });

  it("takes the keys in the server's shape", () => {
    expect(isSyncable("unified.hidden:mini@uwumail.test", true)).toBe(true);
    expect(isSyncable("unified.hidden:mini@uwumail.test", false)).toBe(false);
    expect(isSyncable("unified.folders:312f4066a41e0e45", inbox)).toBe(true);
    expect(isSyncable("folders.favorite:312f4066a41e0e45", { account: "x", folder: "" })).toBe(false);
    expect(isSyncable("folders.hidden:312f4066a41e0e45", { account: "x", folder: "a\u0007b" })).toBe(false);
    expect(isSyncable("folders.hidden:bad id!", inbox)).toBe(false);
    expect(isSyncable("accounts.order", ["a@uwumail.test", "b@uwumail.test"])).toBe(true);
    expect(isSyncable("accounts.order", ["a@uwumail.test", "a@uwumail.test"])).toBe(false);
    expect(isSyncable("accounts.order", ["A@uwumail.test"])).toBe(false);
    expect(
      isSyncable(
        "accounts.order",
        Array.from({ length: 201 }, (_, i) => `${i}@uwumail.test`),
      ),
    ).toBe(false);
  });

  it("writes and reads them back", () => {
    const settings = {
      ...base,
      unifiedHidden: ["work@uwumail.test"],
      unifiedFolders: [projects],
      accountsOrder: ["work@uwumail.test", "mini@uwumail.test"],
      favoriteFolders: [inbox],
      hiddenFolders: [projects],
    };
    const values = settingsToValues(settings);
    expect(values).toMatchObject({
      "unified.hidden:work@uwumail.test": true,
      "unified.folders:256ba3c7a0ede822": projects,
      "accounts.order": ["work@uwumail.test", "mini@uwumail.test"],
      "folders.favorite:312f4066a41e0e45": inbox,
      "folders.hidden:256ba3c7a0ede822": projects,
    });
    expect(applyToSettings(base, values)).toMatchObject({
      unifiedHidden: settings.unifiedHidden,
      unifiedFolders: settings.unifiedFolders,
      accountsOrder: settings.accountsOrder,
      favoriteFolders: settings.favoriteFolders,
      hiddenFolders: settings.hiddenFolders,
    });
  });

  it("goes back to the usual order when the order is gone", () => {
    const ordered = { ...base, accountsOrder: ["work@uwumail.test"] };
    expect(applyToSettings(ordered, { "accounts.order": null })).toMatchObject({ accountsOrder: [] });
  });
});

describe("notifications and snooze", () => {
  const quiet = { enabled: true, from: "22:00", to: "07:00", days: [0, 6] };
  const snooze = {
    account: "mini@uwumail.test",
    messageId: "abc@uwumail.test",
    folder: "INBOX",
    until: "2026-10-21T07:00:00Z",
  };

  it("takes muted mailboxes, quiet hours and snoozes in their shape only", () => {
    expect(isSyncable("notify.muted:mini@uwumail.test", true)).toBe(true);
    expect(isSyncable("notify.muted:Mini@uwumail.test", true)).toBe(false);
    expect(isSyncable("notify.muted:mini@uwumail.test", false)).toBe(false);
    expect(isSyncable("notify.quietHours", quiet)).toBe(true);
    expect(isSyncable("notify.quietHours", { ...quiet, enabled: false })).toBe(true);
    expect(isSyncable("notify.quietHours", { ...quiet, from: "24:00" })).toBe(false);
    expect(isSyncable("notify.quietHours", { ...quiet, to: "7:00" })).toBe(false);
    expect(isSyncable("notify.quietHours", { ...quiet, days: [0, 0] })).toBe(false);
    expect(isSyncable("notify.quietHours", { ...quiet, days: [7] })).toBe(false);
    expect(isSyncable("notify.quietHours", { ...quiet, extra: 1 })).toBe(false);
    expect(isSyncable("snooze:Ab_-0123456789xy", snooze)).toBe(true);
    expect(isSyncable("snooze:a b", snooze)).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, account: "Mini@uwumail.test" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, messageId: "<abc@uwumail.test>" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, messageId: "a b" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, messageId: "" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, messageId: "a".repeat(999) })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, folder: "" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, folder: "a\nb" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, until: "2026-10-21T09:00:00+02:00" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, until: "2026-10-21T07:00:00.123Z" })).toBe(true);
    expect(isSyncable("snooze:a", { ...snooze, until: "2026-13-45T07:00:00Z" })).toBe(false);
    // Like the server: real days and times only, a leap second is fine.
    expect(isSyncable("snooze:a", { ...snooze, until: "2026-02-30T07:00:00Z" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, until: "2028-02-29T07:00:00Z" })).toBe(true);
    expect(isSyncable("snooze:a", { ...snooze, until: "2026-10-21T24:00:00Z" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, until: "2026-12-31T23:59:60Z" })).toBe(true);
    expect(isSyncable("snooze:a", { ...snooze, messageId: "a\u0085b" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, messageId: "a\u3000b" })).toBe(false);
    expect(isSyncable("snooze:a", { ...snooze, messageId: "a\ufeffb" })).toBe(true);
    expect(isSyncable("snooze:a", { ...snooze, folder: "a\u0090b" })).toBe(false);
  });

  it("writes quiet hours only while they are on", () => {
    expect(settingsToValues(base)).not.toHaveProperty(["notify.quietHours"]);
    const values = settingsToValues({
      ...base,
      notifyMuted: ["mini@uwumail.test"],
      quietHours: quiet,
      snoozes: { s1: snooze },
    });
    expect(values).toMatchObject({
      "notify.muted:mini@uwumail.test": true,
      "notify.quietHours": quiet,
      "snooze:s1": snooze,
    });
  });

  it("applies them, and a removed key switches quiet hours off but keeps the times", () => {
    const current = { ...base, notifyMuted: ["a@uwumail.test"], quietHours: quiet, snoozes: { s1: snooze } };
    expect(
      applyToSettings(current, {
        "notify.muted:a@uwumail.test": null,
        "notify.muted:b@uwumail.test": true,
        "notify.quietHours": null,
        "snooze:s1": null,
        "snooze:s2": { ...snooze, until: "2026-10-22T07:00:00Z" },
      }),
    ).toEqual({
      notifyMuted: ["b@uwumail.test"],
      quietHours: { ...quiet, enabled: false },
      snoozes: { s2: { ...snooze, until: "2026-10-22T07:00:00Z" } },
    });
    expect(applyToSettings(base, { "notify.quietHours": quiet })).toEqual({ quietHours: quiet });
    expect(applyToSettings(base, { "notify.quietHours": null })).toEqual({});
  });

  it("drops a snooze another device finished", () => {
    const result = mergeWithServer({
      server: {},
      local: { "snooze:s1": snooze, "notify.quietHours": quiet },
      pending: {},
      firstSync: false,
    });
    expect(result.apply).toEqual({ "snooze:s1": null, "notify.quietHours": null });
    expect(result.pending).toEqual({});
  });
});

describe("entry ids", () => {
  const template = { name: "Thanks", subject: "", html: "<p>Hi</p>" };
  const snooze = {
    account: "mini@uwumail.test",
    messageId: "abc@uwumail.test",
    folder: "INBOX",
    until: "2026-10-21T07:00:00Z",
  };

  it("never takes __proto__ as the id of an entry", () => {
    const folder = { account: "mini@uwumail.test", folder: "INBOX" };
    const lists: [string, unknown][] = [
      ["template", template],
      ["snooze", snooze],
      ["signature", signature],
      ["unified.folders", folder],
      ["folders.favorite", folder],
      ["folders.hidden", folder],
    ];
    for (const [list, value] of lists) {
      expect(isSyncable(`${list}:proto`, value)).toBe(true);
      expect(isSyncable(`${list}:__proto__`, value)).toBe(false);
    }
    const changed = applyToSettings(base, { "template:__proto__": template, "snooze:__proto__": snooze });
    expect(changed.templates).toBeUndefined();
    expect(changed.snoozes).toBeUndefined();
    const templates = applyToSettings(base, { "template:a": template, "template:__proto__": template }).templates!;
    expect(Object.getPrototypeOf(templates)).toBe(Object.prototype);
    expect(Object.keys(templates)).toEqual(["a"]);
  });
});
