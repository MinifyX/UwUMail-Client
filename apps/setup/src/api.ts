import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface Options {
  dir: string;
  desktopShortcut: boolean;
  autostart: boolean;
  defaultMailApp: boolean;
}

export interface Info {
  mode: "install" | "update" | "uninstall";
  version: string;
  installed: { dir: string; version?: string | null; legacy: boolean } | null;
  options: Options;
  appRunning: boolean;
  hasPayload: boolean;
  sandbox: boolean;
  relaunch: boolean;
}

export type Step = "prepare" | "copy" | "shortcuts" | "register" | "cleanup" | "done";

export interface Progress {
  step: Step;
  overall: number;
}

export interface SetupApi {
  info(): Promise<Info>;
  pickFolder(current: string): Promise<string | null>;
  closeApp(): Promise<void>;
  install(options: Options): Promise<void>;
  uninstall(keepData: boolean): Promise<void>;
  launchApp(): Promise<void>;
  openDefaultApps(): Promise<void>;
  finish(): Promise<void>;
  minimize(): Promise<void>;
  onProgress(listener: (progress: Progress) => void): () => void;
}

const tauriApi: SetupApi = {
  info: () => invoke("info"),
  pickFolder: (current) => invoke("pick_folder", { current }),
  closeApp: () => invoke("close_app"),
  install: (options) => invoke("install", { options }),
  uninstall: (keepData) => invoke("uninstall", { keepData }),
  launchApp: () => invoke("launch_app"),
  openDefaultApps: () => invoke("open_default_apps"),
  finish: () => invoke("finish"),
  minimize: () => getCurrentWindow().minimize(),
  onProgress(listener) {
    const stop = listen<Progress>("setup:progress", (event) => listener(event.payload));
    return () => void stop.then((unlisten) => unlisten());
  },
};

/**
 * Pretends to install, for working on the page in a normal browser.
 * `?mode=update`, `?mode=uninstall`, `?running` and `?fail` show the other states.
 */
function previewApi(): SetupApi {
  const params = new URLSearchParams(window.location.search);
  const listeners = new Set<(progress: Progress) => void>();
  let running = params.has("running");
  const pretend = async (steps: Step[]) => {
    for (let i = 1; i <= 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const step = steps[Math.min(steps.length - 1, Math.floor((i / 40) * steps.length))]!;
      for (const listener of listeners) listener({ step, overall: i / 40 });
    }
    if (params.has("fail")) throw "Couldn't write C:\\Users\\Mini\\AppData\\Local\\Programs\\UwUMail\\UwUMail.exe";
  };
  return {
    info: async () => ({
      mode: (params.get("mode") as Info["mode"] | null) ?? "install",
      version: "0.2.0",
      installed: params.get("mode")
        ? { dir: "C:\\Users\\Mini\\AppData\\Local\\Programs\\UwUMail", version: "0.1.0", legacy: false }
        : null,
      options: {
        dir: "C:\\Users\\Mini\\AppData\\Local\\Programs\\UwUMail",
        desktopShortcut: true,
        autostart: false,
        defaultMailApp: false,
      },
      appRunning: running,
      hasPayload: true,
      sandbox: false,
      relaunch: true,
    }),
    pickFolder: async () => "D:\\Apps\\UwUMail",
    closeApp: async () => {
      running = false;
    },
    install: () => pretend(["prepare", "copy", "shortcuts", "register"]),
    uninstall: () => pretend(["prepare", "shortcuts", "register", "copy", "cleanup"]),
    launchApp: async () => {},
    openDefaultApps: async () => {},
    finish: async () => window.location.reload(),
    minimize: async () => {},
    onProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const api: SetupApi = "__TAURI_INTERNALS__" in window ? tauriApi : previewApi();

export const isPreview = !("__TAURI_INTERNALS__" in window);
