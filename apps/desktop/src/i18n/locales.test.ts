import { describe, expect, it } from "vitest";
import deNeutral from "./locales/de/neutral.json";
import dePlayful from "./locales/de/playful.json";
import enNeutral from "./locales/en/neutral.json";
import enPlayful from "./locales/en/playful.json";
import zhCNNeutral from "./locales/zh_CN/neutral.json";
import zhCNPlayful from "./locales/zh_CN/playful.json";
import zhTWNeutral from "./locales/zh_TW/neutral.json";
import zhTWPlayful from "./locales/zh_TW/playful.json";

type Tree = { [key: string]: string | Tree };

function keys(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : keys(value, `${prefix}${key}.`),
  );
}

describe("locales", () => {
  it("all locales have the same neutral keys", () => {
    const expected = keys(enNeutral).sort();
    for (const locale of [deNeutral, zhCNNeutral, zhTWNeutral]) {
      expect(keys(locale).sort()).toEqual(expected);
    }
  });

  // i18next checks the playful namespace in every language before falling back
  // to neutral, so a playful key missing in one language would show the other
  // language's text.
  it("all locales have the same playful keys", () => {
    const expected = keys(enPlayful).sort();
    for (const locale of [dePlayful, zhCNPlayful, zhTWPlayful]) {
      expect(keys(locale).sort()).toEqual(expected);
    }
  });

  it("every playful key overrides an existing neutral key", () => {
    const neutral = new Set(keys(enNeutral));
    expect(keys(enPlayful).filter((key) => !neutral.has(key))).toEqual([]);
  });
});

describe("the system's language", () => {
  it("is the first of the preferred languages the app speaks", async () => {
    const { systemLanguage } = await import("./index");
    expect(systemLanguage(["fr-FR", "de-CH", "en"])).toBe("de");
    expect(systemLanguage(["en-GB", "de"])).toBe("en");
    expect(systemLanguage(["ja", "zh_Hans"])).toBe("zh_CN");
    expect(systemLanguage(["zh-TW"])).toBe("zh_TW");
    expect(systemLanguage(["zh-CN"])).toBe("zh_CN");
    expect(systemLanguage([])).toBe("en");
  });
});
