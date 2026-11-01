import clsx from "clsx";
import { TextInput, Toggle } from "@uwusuite/design";
import { useT } from "@/i18n";
import { accountLabel } from "@/lib/accountLabel";
import { accountAddress } from "@/lib/arrangement";
import { useAccounts } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { Row } from "./Row";

/** Monday first; the values are the synced ones (0 = Sunday). */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Which mailboxes may ring, and the hours when none does. Both sync between devices. */
export function NotificationSettings() {
  const { t, i18n } = useT();
  const { data: accounts = [] } = useAccounts();
  const muted = useSettings((s) => s.notifyMuted);
  const quiet = useSettings((s) => s.quietHours);
  const update = useSettings((s) => s.update);
  const dayName = (day: number) =>
    // 4 January 2026 was a Sunday.
    new Date(2026, 0, 4 + day).toLocaleDateString(i18n.language, { weekday: "short" });

  const setMuted = (address: string, mute: boolean) => {
    const rest = muted.filter((each) => each !== address);
    update({ notifyMuted: mute ? [...rest, address] : rest });
  };
  const toggleDay = (day: number) => {
    const days = quiet.days.includes(day) ? quiet.days.filter((each) => each !== day) : [...quiet.days, day];
    update({ quietHours: { ...quiet, days: days.sort((a, b) => a - b) } });
  };

  const codeOnLockScreen = useSettings((s) => s.notifyCodeOnLockScreen);

  return (
    <>
      <div className="border-b border-hairline py-4">
        <Toggle
          checked={codeOnLockScreen}
          onChange={(notifyCodeOnLockScreen) => update({ notifyCodeOnLockScreen })}
          label={t("codes.lockScreen")}
          description={t("codes.lockScreenDesc")}
        />
      </div>
      {accounts.length > 0 && (
        <Row label={t("notify.accounts")} description={t("notify.accountsDesc")}>
          <div className="flex flex-col gap-1">
            {accounts.map((account) => {
              const address = accountAddress(account);
              return (
                <Toggle
                  key={account.id}
                  checked={!muted.includes(address)}
                  onChange={(on) => setMuted(address, !on)}
                  label={accountLabel(account)}
                  description={account.email !== accountLabel(account) ? account.email : undefined}
                />
              );
            })}
          </div>
        </Row>
      )}
      <div className="flex flex-col gap-3 border-b border-hairline py-4">
        <Toggle
          checked={quiet.enabled}
          onChange={(enabled) => update({ quietHours: { ...quiet, enabled } })}
          label={t("notify.quiet")}
          description={t("notify.quietDesc")}
        />
        {quiet.enabled && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
              <label className="flex items-center gap-2">
                {t("notify.from")}
                <TextInput
                  type="time"
                  value={quiet.from}
                  className="w-[120px]"
                  onChange={(event) => {
                    const from = event.target.value;
                    if (CLOCK.test(from)) update({ quietHours: { ...quiet, from } });
                  }}
                />
              </label>
              <label className="flex items-center gap-2">
                {t("notify.to")}
                <TextInput
                  type="time"
                  value={quiet.to}
                  className="w-[120px]"
                  onChange={(event) => {
                    const to = event.target.value;
                    if (CLOCK.test(to)) update({ quietHours: { ...quiet, to } });
                  }}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("notify.days")}>
              {WEEK.map((day) => {
                const on = quiet.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(day)}
                    className={clsx(
                      "h-8 min-w-11 rounded-full px-3 text-[12.5px] font-semibold focus-visible:shadow-focus focus-visible:outline-none",
                      on ? "bg-pink-solid text-on-pink" : "bg-canvas text-muted hover:bg-pink-tint/60",
                    )}
                  >
                    {dayName(day)}
                  </button>
                );
              })}
            </div>
            {quiet.days.length === 0 && <p className="text-[12.5px] text-muted">{t("notify.noDays")}</p>}
          </>
        )}
      </div>
    </>
  );
}
