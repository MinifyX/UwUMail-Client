import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { useSettings, type LanguageSetting } from "@/state/settings";
import deNeutral from "./locales/de/neutral.json";
import dePlayful from "./locales/de/playful.json";
import enNeutral from "./locales/en/neutral.json";
import enPlayful from "./locales/en/playful.json";
import zhCNNeutral from "./locales/zh-CN/neutral.json";
import zhCNPlayful from "./locales/zh-CN/playful.json";
import zhTWNeutral from "./locales/zh-TW/neutral.json";
import zhTWPlayful from "./locales/zh-TW/playful.json";

export type Language = "de" | "en" | "zh-CN" | "zh-TW";

export const resources = {
  en: { neutral: enNeutral, playful: enPlayful },
  de: { neutral: deNeutral, playful: dePlayful },
  "zh-CN": { neutral: zhCNNeutral, playful: zhCNPlayful },
  "zh-TW": { neutral: zhTWNeutral, playful: zhTWPlayful },
} as const;

const LANGUAGES: readonly Language[] = ["de", "en", "zh-CN", "zh-TW"];

/** The first of the system's languages the app speaks, English when it speaks none of them. */
export function systemLanguage(
  preferred: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language],
): Language {
  for (const tag of preferred) {
    const normalized = tag.toLowerCase().replace(/_/g, "-");
    // Match full locale first (zh-CN / zh-TW), then base language.
    if (normalized.startsWith("zh")) {
      // zh-TW, zh-HK, zh-MO, or any with TW/HK/MO region -> traditional
      if (/zh-(tw|hk|mo)/.test(normalized) || /hant/.test(normalized)) return "zh-TW";
      return "zh-CN";
    }
    const base = normalized.split("-")[0];
    const found = LANGUAGES.find((language) => language === base);
    if (found) return found;
  }
  return "en";
}

export function resolveLanguage(setting: LanguageSetting): Language {
  return LANGUAGES.includes(setting as Language) ? (setting as Language) : systemLanguage();
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
