import clsx from "clsx";
import { useT } from "@/i18n";
import { useAssistUsage } from "../useAssist";
import { dailyTotals, featureTotals, todayShare } from "../usage";
import { Section } from "./common";

const DAYS = 30;

/** What the assistant used: today against each provider's limits, and the last 30 days. */
export function UsageSettings() {
  const { t, i18n } = useT();
  const { data: usage, isPending, isError } = useAssistUsage();
  const number = new Intl.NumberFormat(i18n.language);
  const compact = new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 });
  const days = usage ? dailyTotals(usage, DAYS) : [];
  const features = usage ? featureTotals(usage) : [];
  const peak = Math.max(1, ...days.map((day) => day.requests));
  const total = days.reduce(
    (sum, day) => ({ requests: sum.requests + day.requests, tokens: sum.tokens + day.tokens }),
    {
      requests: 0,
      tokens: 0,
    },
  );
  const dayName = new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <Section title={t("assist.usage.title")} description={t("assist.usage.description")}>
      {isPending && <p className="text-[13px] text-muted">{t("assist.usage.loading")}</p>}
      {isError && <p className="text-[13px] text-danger">{t("assist.usage.failed")}</p>}
      {usage && (
        <>
          <div className="flex flex-col gap-2">
            <p className="text-[12px] font-bold tracking-wide text-muted uppercase">{t("assist.usage.today")}</p>
            {usage.today.length === 0 ? (
              <p className="text-[13px] text-muted">{t("assist.usage.nothingToday")}</p>
            ) : (
              usage.today.map((entry) => {
                const share = todayShare(entry);
                return (
                  <div key={entry.providerId} className="flex flex-col gap-1.5 rounded-2xl bg-canvas px-3.5 py-2.5">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3 text-[13px]">
                      <span className="font-semibold">{entry.providerName}</span>
                      <span className="text-[12px] text-muted">
                        {[
                          entry.requestsPerDay != null
                            ? t("assist.usage.requestsOf", {
                                used: number.format(entry.requests),
                                limit: number.format(entry.requestsPerDay),
                              })
                            : t("assist.usage.requests", {
                                count: entry.requests,
                                formatted: number.format(entry.requests),
                              }),
                          entry.tokensPerDay != null
                            ? t("assist.usage.tokensOf", {
                                used: compact.format(entry.tokens),
                                limit: compact.format(entry.tokensPerDay),
                              })
                            : t("assist.usage.tokens", { formatted: compact.format(entry.tokens) }),
                        ].join(" · ")}
                      </span>
                    </p>
                    {share.max !== null && (
                      <span
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(share.max * 100)}
                        aria-label={t("assist.usage.limitUsed", { percent: Math.round(share.max * 100) })}
                        className="h-1.5 overflow-hidden rounded-full bg-line"
                      >
                        <span
                          className={clsx(
                            "block h-full rounded-full",
                            share.max >= 1 ? "bg-danger" : share.max > 0.8 ? "bg-warning" : "bg-pink",
                          )}
                          style={{ width: `${Math.max(2, Math.round(share.max * 100))}%` }}
                        />
                      </span>
                    )}
                    {share.max !== null && share.max >= 1 && (
                      <p className="text-[12px] text-danger">{t("assist.usage.limitReached")}</p>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-[12px] font-bold tracking-wide text-muted uppercase">
                {t("assist.usage.lastDays", { count: DAYS })}
              </span>
              <span className="text-[12px] text-muted">
                {t("assist.usage.requests", { count: total.requests, formatted: number.format(total.requests) })} ·{" "}
                {t("assist.usage.tokens", { formatted: compact.format(total.tokens) })}
              </span>
            </p>
            <div className="flex h-16 items-end gap-[3px] rounded-2xl bg-canvas px-3 pt-3 pb-2" aria-hidden>
              {days.map((day) => (
                <span
                  key={day.day}
                  title={`${dayName.format(new Date(`${day.day}T00:00:00Z`))}: ${t("assist.usage.requests", {
                    count: day.requests,
                    formatted: number.format(day.requests),
                  })}`}
                  className={clsx("min-w-0 flex-1 rounded-t-[3px]", day.requests > 0 ? "bg-pink/70" : "bg-line/60")}
                  style={{ height: `${day.requests > 0 ? Math.max(8, (day.requests / peak) * 100) : 4}%` }}
                />
              ))}
            </div>
            {features.length > 0 ? (
              <ul className="grid gap-1.5 text-[12.5px] sm:grid-cols-2">
                {features.map((entry) => (
                  <li
                    key={entry.feature}
                    className="flex items-baseline justify-between gap-2 rounded-xl bg-canvas px-3 py-1.5"
                  >
                    <span className="font-semibold">
                      {t(`assist.feature.${entry.feature}`, { defaultValue: entry.feature })}
                    </span>
                    <span className="text-muted">
                      {t("assist.usage.requests", { count: entry.requests, formatted: number.format(entry.requests) })}{" "}
                      · {t("assist.usage.tokens", { formatted: compact.format(entry.tokens) })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">{t("assist.usage.nothing")}</p>
            )}
          </div>
        </>
      )}
    </Section>
  );
}
