/**
 * UwUMail on macOS (docs/design.md, and docs/macos.md in @uwusuite/design): the window keeps the
 * system's title bar, the app's actions live in the menu bar, ⌘W hides the window while UwUMail
 * stays in the Dock, and quitting saves the open draft first.
 *
 * **Keys.** Every accelerator here carries ⌘. The in-app keys (lib/hotkeys.ts) are single letters
 * (c, r, a, f, /) plus ⌘K, ⌘, and ⌘A, so a ⌘ chord the menu owns (⌘N, ⌘R, ⇧⌘R, ⇧⌘F, ⌘F, ⇧⌘N,
 * ⌘1–3) has no second listener in the page and runs once. The three both know (⌘K, ⌘,, ⌘A) do the
 * same thing either way, and the page's handler takes the key first (preventDefault), so the menu's
 * does not run as well. No entry gets a key without ⌘: it would take that key from every text field.
 *
 * Everything here does nothing off macOS.
 */

import { hideWindowOnClose, onMacQuit, setMacMenu } from "@uwusuite/design/tauri";
import type { MacMenuEntry, MacMenuOptions } from "@uwusuite/design/tauri";
import { useEffect, useRef } from "react";
import { backend } from "@/backend/backend";
import { resolveLanguage, useT } from "@/i18n";
import { useUpdatesInApp } from "@/lib/distribution";
import { desktopPlatform, openExternal } from "@/lib/platform";
import { flushBeforeQuit, onQuit } from "@/lib/quit";
import { flushAccountSync } from "@/state/accountSync";
import { isLocked } from "@/state/lock";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi, type AppSection } from "@/state/ui";
import type { Command } from "./commands";

const REPOSITORY = "https://github.com/MinifyX/UwUMail-Client";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface MailMenuState {
  t: Translate;
  /** The shell's commands (commands.ts); `null` before the first account (onboarding). */
  commands: Command[] | null;
  section: AppSection;
  /** A conversation is open, so reply, forward, archive … have something to act on. */
  hasThread: boolean;
  /** Runs a command or another action from the menu, see `guard`. */
  run: (action: () => void | Promise<void>, always?: boolean) => void;
  /** UwUMail updates itself (not in the App Store build), so the app menu offers a check. */
  updates?: boolean;
}

/**
 * The menu bar's content for `setMacMenu`, as plain data, so it can be tested without Tauri. The
 * same commands as the keys and the command palette, so all three run one code path.
 */
export function mailMenu({
  t,
  commands,
  section,
  hasThread,
  run,
  updates = true,
}: MailMenuState): Omit<MacMenuOptions, "appName"> {
  if (!commands) {
    return {
      help: [{ id: "help.website", text: t("macMenu.website"), action: () => void openExternal(REPOSITORY) }],
    };
  }
  const byId = new Map(commands.map((command) => [command.id, command]));
  const entry = (
    id: string,
    { text, accelerator, enabled = true }: { text?: string; accelerator?: string; enabled?: boolean } = {},
  ): MacMenuEntry[] => {
    const command = byId.get(id);
    if (!command) return [];
    const usable = enabled && (!command.needsThread || (section === "mail" && hasThread));
    return [
      {
        id: `command.${id}`,
        text: text ?? command.title,
        accelerator,
        enabled: usable,
        action: () => run(command.run),
      },
    ];
  };
  // Search needs the mail's list on screen; from the calendar it goes there first.
  const find = (): MacMenuEntry[] => {
    const search = byId.get("search");
    if (!search) return [];
    return [
      {
        id: "command.search",
        text: t("macMenu.find"),
        accelerator: "CmdOrCtrl+F",
        action: () =>
          run(() => {
            if (useUi.getState().section !== "mail") useUi.getState().setSection("mail");
            requestAnimationFrame(() => void search.run());
          }),
      },
    ];
  };
  const sections: [AppSection, string, string][] = [
    ["mail", "mail", "CmdOrCtrl+1"],
    ["calendar", "goCalendar", "CmdOrCtrl+2"],
    ["contacts", "goContacts", "CmdOrCtrl+3"],
  ];
  const sectionEntries = sections.flatMap(([name, commandId, accelerator]): MacMenuEntry[] =>
    name === "mail" || byId.has(commandId)
      ? [
          {
            id: `section.${name}`,
            text: t(`nav.section.${name}`),
            accelerator,
            checked: section === name,
            action: () => run(() => useUi.getState().setSection(name)),
          },
        ]
      : [],
  );
  const getMail = () =>
    run(async () => {
      try {
        await backend().syncNow();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), "error");
      }
    });

  return {
    onSettings: () => run(() => useUi.getState().openSettings(), true),
    app: updates
      ? [
          {
            id: "app.updates",
            text: t("macMenu.checkUpdates"),
            action: () => run(() => useUi.getState().openSettings("about"), true),
          },
        ]
      : [],
    file: [
      ...entry("compose", { text: t("macMenu.newMail"), accelerator: "CmdOrCtrl+N" }),
      ...entry("newEvent", { text: t("macMenu.newEvent") }),
      ...entry("newContact", { text: t("macMenu.newContact") }),
    ],
    edit: [...find(), "separator", ...entry("undo")],
    view: [
      ...sectionEntries,
      "separator",
      ...entry("layout"),
      ...entry("theme"),
      ...entry("tone"),
      "separator",
      {
        id: "view.palette",
        text: t("macMenu.palette"),
        accelerator: "CmdOrCtrl+K",
        action: () => run(() => useUi.getState().setPaletteOpen(true), true),
      },
    ],
    menus: [
      {
        text: t("macMenu.mailbox"),
        items: [
          { id: "mailbox.getMail", text: t("macMenu.getMail"), accelerator: "CmdOrCtrl+Shift+N", action: getMail },
          "separator",
          ...entry("inbox"),
          ...entry("goSent"),
          ...entry("goDrafts"),
          ...entry("goFlagged"),
        ],
      },
      {
        text: t("macMenu.message"),
        items: [
          ...entry("reply", { accelerator: "CmdOrCtrl+R" }),
          ...entry("replyAll", { accelerator: "CmdOrCtrl+Shift+R" }),
          ...entry("forward", { accelerator: "CmdOrCtrl+Shift+F" }),
          "separator",
          ...entry("archive"),
          ...entry("trash"),
          ...entry("move", { text: t("macMenu.move") }),
          ...entry("label", { text: t("macMenu.label") }),
          ...entry("spam"),
          "separator",
          ...entry("flag"),
          ...entry("unread"),
        ],
      },
    ],
    help: [
      ...entry("shortcuts", { text: t("macMenu.shortcuts") }),
      "separator",
      { id: "help.website", text: t("macMenu.website"), action: () => void openExternal(REPOSITORY) },
      {
        id: "help.releases",
        text: t("macMenu.releaseNotes"),
        action: () => void openExternal(`${REPOSITORY}/releases`),
      },
      { id: "help.report", text: t("macMenu.report"), action: () => void openExternal(`${REPOSITORY}/issues/new`) },
    ],
  };
}

/**
 * Like the in-app keys: nothing behind the app lock, and nothing while a dialog asks something,
 * except what opens a window of its own (`always`: settings, the command palette).
 */
function guard(action: () => void | Promise<void>, always = false) {
  if (isLocked()) return;
  if (!always && document.querySelector("dialog[open]")) return;
  void action();
}

/** What the menu shows, to skip rebuilding a menu bar that would look the same. */
function fingerprint(options: Omit<MacMenuOptions, "appName">) {
  return JSON.stringify(options, (key, value: unknown) => (key === "action" ? undefined : value));
}

/**
 * Fills the macOS menu bar. `commands` is the shell's list (MailShell); `null` while there is no
 * account yet, which leaves the app menu, Bearbeiten (⌘C/⌘V in the setup's fields) and Hilfe.
 */
export function useMacMenu(commands: Command[] | null, enabled = true) {
  const { t } = useT();
  const language = useSettings((s) => s.language);
  const section = useUi((s) => s.section);
  const hasThread = useUi((s) => s.selectedThreadId !== null);
  const updates = useUpdatesInApp();
  const shown = useRef<{ key: string; menu: { close(): Promise<void> } | null } | null>(null);

  useEffect(() => {
    if (desktopPlatform !== "mac") return;
    if (!enabled) {
      // Someone else fills the bar now; when this one is back, it sets its menu again.
      shown.current = null;
      return;
    }
    const options = mailMenu({ t, commands, section, hasThread, run: guard, updates });
    const lang = resolveLanguage(language);
    const key = `${lang}${fingerprint(options)}`;
    if (shown.current?.key === key) return;
    // Moving through the list changes the open conversation many times a second.
    const timer = setTimeout(() => {
      void setMacMenu({ appName: "UwUMail", lang, ...options }, "mac")
        .then((menu) => {
          const previous = shown.current?.menu;
          shown.current = { key, menu };
          // The old bar's items live on in Rust until they are closed.
          void previous?.close().catch(() => undefined);
        })
        .catch(() => undefined);
    }, 120);
    return () => clearTimeout(timer);
  }, [t, commands, section, hasThread, language, enabled, updates]);
}

/**
 * ⌘W and the red light hide the window (a click on the Dock icon brings it back, desktop.rs);
 * ⌘Q, the Dock, the menu bar icon's "Beenden" and logging out first save the open draft and send
 * waiting settings, then quit (uwu-macos holds the quit meanwhile, ten seconds at most).
 */
export function useMacLifecycle() {
  useEffect(() => {
    if (desktopPlatform !== "mac") return;
    const stops: (() => void)[] = [];
    let stopped = false;
    const keep = (stop: () => void) => (stopped ? stop() : stops.push(stop));
    const offSync = onQuit(flushAccountSync);
    void (async () => {
      keep(await hideWindowOnClose("mac"));
      keep(await onMacQuit(() => flushBeforeQuit(), { platform: "mac" }));
    })().catch(() => undefined);
    return () => {
      stopped = true;
      offSync();
      stops.forEach((stop) => stop());
    };
  }, []);
}
