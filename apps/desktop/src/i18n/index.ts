import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { useSettings, type LanguageSetting } from "@/state/settings";
import deNeutral from "./locales/de/neutral.json";
import dePlayful from "./locales/de/playful.json";
import enNeutral from "./locales/en/neutral.json";
import enPlayful from "./locales/en/playful.json";

export type Language = "de" | "en";

export const resources = {
  en: { neutral: enNeutral, playful: enPlayful },
  de: { neutral: deNeutral, playful: dePlayful },
} as const;

const LANGUAGES: readonly Language[] = ["de", "en"];

/** The first of the system's languages the app speaks, English when it speaks none of them. */
export function systemLanguage(
  preferred: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language],
): Language {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    const found = LANGUAGES.find((language) => language === base);
    if (found) return found;
  }
  return "en";
}

export function resolveLanguage(setting: LanguageSetting): Language {
  return setting === "de" || setting === "en" ? setting : systemLanguage();
}

void i18n.use(initReactI18next).init({
  resources,
  lng: resolveLanguage(useSettings.getState().language),
  fallbackLng: "en",
  ns: ["neutral", "playful"],
  defaultNS: "neutral",
  // Playful strings only override some keys; everything else comes from neutral.
  fallbackNS: "neutral",
  interpolation: { escapeValue: false },
});

/** `t` for the active tone. Every component should use this instead of useTranslation. */
export function useT() {
  const tone = useSettings((s) => s.tone);
  return useTranslation(tone);
}

/** `t` for the active tone, for code outside components (toasts from actions, events). */
export function translate(key: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ...options, ns: useSettings.getState().tone });
}

export { i18n };
