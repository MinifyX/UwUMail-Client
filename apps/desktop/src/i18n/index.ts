import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import { useSettings, type LanguageSetting } from "@/state/settings";
import deNeutral from "./locales/de/neutral.json";
import dePlayful from "./locales/de/playful.json";
import enNeutral from "./locales/en/neutral.json";
import enPlayful from "./locales/en/playful.json";
import zhCNNeutral from "./locales/zh_CN/neutral.json";
import zhCNPlayful from "./locales/zh_CN/playful.json";
import zhTWNeutral from "./locales/zh_TW/neutral.json";
import zhTWPlayful from "./locales/zh_TW/playful.json";

export type Language = "de" | "en" | "zh_CN" | "zh_TW";

export const resources = {
  en: { neutral: enNeutral, playful: enPlayful },
  de: { neutral: deNeutral, playful: dePlayful },
  zh_CN: { neutral: zhCNNeutral, playful: zhCNPlayful },
  zh_TW: { neutral: zhTWNeutral, playful: zhTWPlayful },
} as const;

const LANGUAGES: readonly Language[] = ["de", "en", "zh_CN", "zh_TW"];

/** The first of the system's languages the app speaks, English when it speaks none of them. */
export function systemLanguage(
  preferred: readonly string[] = navigator.languages?.length ? navigator.languages : [navigator.language],
): Language {
  for (const tag of preferred) {
    const normalized = tag.toLowerCase().replace(/[-]/g, "_");
    // Match full locale first (zh_CN / zh_TW), then base language.
    if (normalized.startsWith("zh")) {
      // zh-TW, zh-HK, zh-MO, or any with TW/HK/MO region -> traditional
      if (/zh_(tw|hk|mo)/.test(normalized) || /hant/.test(normalized)) return "zh_TW";
      return "zh_CN";
    }
    const base = normalized.split("_")[0];
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
