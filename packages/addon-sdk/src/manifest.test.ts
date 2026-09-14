import { describe, expect, it } from "vitest";
import { localize, validateManifest } from "./manifest";

const valid = {
  manifestVersion: 1,
  id: "dev.example.hello-uwu",
  version: "1.0.0",
  name: { en: "Hello UwU", de: "Hallo UwU" },
  description: "Says hi.",
  author: { name: "Example Dev" },
  engines: { uwumail: ">=0.1.0" },
  permissions: ["messages.read", "notifications"],
  hosts: ["https://api.example.dev"],
  background: "background.js",
  contributes: {
    commands: [{ id: "greet", title: "Greet" }],
    messageActions: [{ command: "greet", icon: "hand" }],
    panels: [{ id: "stats", title: "Stats", icon: "chart-bar", entry: "panel.html" }],
  },
};

describe("validateManifest", () => {
  it("accepts a complete manifest", () => {
    expect(validateManifest(valid)).toMatchObject({ ok: true });
  });

  it("reports every problem at once", () => {
    const result = validateManifest({
      ...valid,
      id: "Hello",
      permissions: ["messages.read", "files.write"],
      hosts: ["http://insecure.example"],
      background: "../escape.js",
      contributes: { messageActions: [{ command: "missing", icon: "x" }] },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toEqual([
      "id",
      "permissions[1]",
      "hosts[0]",
      "background",
      "contributes.messageActions[0].command",
    ]);
  });

  it("rejects non-objects", () => {
    expect(validateManifest("nope")).toMatchObject({ ok: false });
  });
});

describe("localize", () => {
  it("falls back from region to language to English", () => {
    const value = { en: "Hello", de: "Hallo" };
    expect(localize(value, "de-AT")).toBe("Hallo");
    expect(localize(value, "fr")).toBe("Hello");
    expect(localize("Plain", "de")).toBe("Plain");
  });
});
