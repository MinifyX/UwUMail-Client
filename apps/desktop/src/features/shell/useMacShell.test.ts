import { QueryClient } from "@tanstack/react-query";
import { macMenuSpec } from "@uwusuite/design/tauri";
import { describe, expect, it, vi } from "vitest";
import { buildCommands } from "./commands";
import { mailMenu, type MailMenuState } from "./useMacShell";

const t = (key: string) => key;

function menu(overrides: Partial<MailMenuState> = {}) {
  const commands = buildCommands(new QueryClient(), t, { calendar: true, contacts: true });
  return mailMenu({ t, commands, section: "mail", hasThread: true, run: (action) => void action(), ...overrides });
}

type Item = { id?: string; text?: string; accelerator?: string; enabled?: boolean; action?: () => void };

function items(options = menu()) {
  return macMenuSpec({ appName: "UwUMail", lang: "de", ...options }).flatMap((submenu) => submenu.items as Item[]);
}

describe("the macOS menu bar", () => {
  it("gives every shortcut ⌘ and no shortcut twice", () => {
    const accelerators = items()
      .map((item) => item.accelerator)
      .filter((accelerator): accelerator is string => Boolean(accelerator));
    expect(accelerators).toContain("CmdOrCtrl+N");
    expect(accelerators).toContain("CmdOrCtrl+R");
    expect(accelerators).toContain("CmdOrCtrl+Shift+R");
    expect(accelerators).toContain("CmdOrCtrl+Shift+F");
    expect(accelerators).toContain("CmdOrCtrl+F");
    // A key without ⌘ would be taken from every text field.
    for (const accelerator of accelerators) expect(accelerator).toMatch(/^CmdOrCtrl\+/);
    expect(new Set(accelerators).size).toBe(accelerators.length);
    // macOS keeps these for itself (docs/macos.md in @uwusuite/design).
    for (const system of ["CmdOrCtrl+H", "CmdOrCtrl+M", "CmdOrCtrl+Q", "CmdOrCtrl+W"]) {
      expect(accelerators).not.toContain(system);
    }
  });

  it("offers replying and the like only with a conversation open in the mail", () => {
    const reply = (state: Partial<MailMenuState>) => items(menu(state)).find((item) => item.id === "command.reply");
    expect(reply({})?.enabled).toBe(true);
    expect(reply({ hasThread: false })?.enabled).toBe(false);
    expect(reply({ section: "calendar" })?.enabled).toBe(false);
    // Composing works from everywhere.
    const compose = items(menu({ hasThread: false })).find((item) => item.id === "command.compose");
    expect(compose?.enabled).toBe(true);
  });

  it("runs the menu's actions through the guard", () => {
    const run = vi.fn();
    const settings = items(menu({ run })).find((item) => item.id === "app.settings");
    settings?.action?.();
    expect(run).toHaveBeenCalledWith(expect.any(Function), true);
  });

  it("leaves out the calendar and contacts when there are none", () => {
    const commands = buildCommands(new QueryClient(), t);
    const ids = items(mailMenu({ t, commands, section: "mail", hasThread: false, run: vi.fn() })).map(
      (item) => item.id,
    );
    expect(ids).toContain("section.mail");
    expect(ids).not.toContain("section.calendar");
    expect(ids).not.toContain("command.newEvent");
  });

  it("has only the help before the first account", () => {
    const options = mailMenu({ t, commands: null, section: "mail", hasThread: false, run: vi.fn() });
    expect(options.onSettings).toBeUndefined();
    expect(options.help?.length).toBe(1);
  });
});
