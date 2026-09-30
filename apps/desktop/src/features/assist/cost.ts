/**
 * Costs of the assistant in the person's money: which currency, and how an amount reads. The
 * UwUMail server and this device both price every call in USD and convert it with the ECB's
 * reference rates. The same rules as UwUMail Webmail's.
 */

import type { AssistCost } from "@/backend/types";
import { useT } from "@/i18n";
import { CURRENCY_CHOICES, useSettings, type CurrencyChoice } from "@/state/settings";

/** The base language of a tag: `en-GB` → `en`. */
const base = (language: string) => language.toLowerCase().split("-")[0] ?? "";

/** Whether the person may pick between euros and dollars: only in English. */
export function mayChooseCurrency(language: string): boolean {
  return base(language) === "en";
}

/** Yen in Japanese, yuan in Chinese, euros otherwise; in English euros or dollars as chosen. */
export function assistCurrency(language: string, choice: CurrencyChoice | undefined): string {
  switch (base(language)) {
    case "ja":
      return "JPY";
    case "zh":
      return "CNY";
    case "en":
      return choice && (CURRENCY_CHOICES as readonly string[]).includes(choice) ? choice : "EUR";
    default:
      return "EUR";
  }
}

/** The currency costs are asked in, for the UI's language and the person's choice. */
export function useAssistCurrency(): string {
  const { i18n } = useT();
  const choice = useSettings((s) => s.assistCurrency);
  return assistCurrency(i18n.language, choice);
}

/** The smallest amount worth writing out; below it an amount reads "< …". */
function smallest(currency: string): number {
  return currency === "JPY" ? 0.01 : 0.0001;
}

/**
 * An amount in the locale's currency format: whole amounts as usual, small ones with two
 * significant digits ("€0.0023"), tiny ones as "< €0.0001". `approximate` marks an estimate.
 */
export function formatCost(
  cost: Pick<AssistCost, "amount" | "currency">,
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string,
  approximate = false,
): string {
  const { amount, currency } = cost;
  if (amount === 0) return t("assist.cost.free");
  const format = (value: number, options: Intl.NumberFormatOptions = {}) => {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency, ...options }).format(value);
    } catch {
      return `${value} ${currency}`;
    }
  };
  const floor = smallest(currency);
  if (amount < floor) return t("assist.cost.below", { amount: format(floor, { maximumSignificantDigits: 1 }) });
  const text = amount < 1 ? format(amount, { maximumSignificantDigits: 2 }) : format(amount);
  return approximate ? t("assist.cost.about", { amount: text }) : text;
}

/** The costs of several rows added up; null when none of them had one. */
export function sumCosts(costs: readonly (AssistCost | null | undefined)[]): AssistCost | null {
  const known = costs.filter((cost): cost is AssistCost => Boolean(cost));
  if (known.length === 0) return null;
  const usd = known.every((cost) => cost.usd !== null) ? known.reduce((sum, cost) => sum + cost.usd!, 0) : null;
  return { amount: known.reduce((sum, cost) => sum + cost.amount, 0), currency: known[0]!.currency, usd };
}
