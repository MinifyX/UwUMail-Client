import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Select } from "@/components/ui/Field";
import { i18n, useT } from "@/i18n";
import { useAccounts } from "@/lib/queries";
import type { SyncStatus } from "@/lib/settingsSyncQueue";
import { useAccountSync } from "@/state/accountSync";
import { useSettings } from "@/state/settings";
import { Row } from "./Row";

/** "vor 2 Min." and the like, from the language the app speaks. */
export function sinceText(then: number, now: number, language: string): string {
  const seconds = Math.round((then - now) / 1000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  if (Math.abs(seconds) < 60) return format.format(0, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

/** Re-renders now and then, so "2 min ago" keeps up. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function StatusLine({ status, email }: { status: SyncStatus | null; email: string }) {
  const { t } = useT();
  const now = useNow(30_000);
  let text: string;
  let failed = false;
  if (!status || status.phase === "syncing") {
    text = t("settings.syncSyncing", { email });
  } else if (status.phase === "error") {
    failed = true;
    text =
      status.problem === "offline"
        ? t("settings.syncOffline", { email, count: status.pending })
        : t("settings.syncFailed", { email, detail: status.detail ?? "" });
  } else {
    text = status.lastSync
      ? t("settings.syncDone", { email, when: sinceText(status.lastSync, now, i18n.language) })
      : t("settings.syncSyncing", { email });
  }
  return (
    <div className="flex flex-col gap-1">
      <p
        role="status"
        className={
          failed
            ? "flex items-center gap-1.5 text-[13px] text-danger"
            : "flex items-center gap-1.5 text-[13px] text-muted"
        }
      >
        <RefreshCw className={status?.phase === "syncing" ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
        {text}
      </p>
      {status && status.refused > 0 && (
        <p className="text-[13px] text-muted">{t("settings.syncRefused", { count: status.refused })}</p>
      )}
    </div>
  );
}

/** Settings → Accounts: which UwUMail account carries the settings that follow the account. */
export function SettingsSyncRow() {
  const { t } = useT();
  const { data: accounts = [] } = useAccounts();
  const choice = useSettings((s) => s.settingsSyncAccount);
  const update = useSettings((s) => s.update);
  const { accountId, candidates, status } = useAccountSync();
  const offered = accounts.filter((account) => candidates.includes(account.id) || account.id === accountId);
  const syncing = accounts.find((account) => account.id === accountId);
  const value = choice === "off" ? "off" : (accountId ?? "");

  return (
    <Row label={t("settings.syncAccount")} description={t("settings.syncAccountDesc")}>
      {offered.length === 0 && choice !== "off" ? (
        <p className="text-[13px] text-muted">{t("settings.syncNone")}</p>
      ) : (
        <Select
          aria-label={t("settings.syncAccount")}
          value={value}
          onChange={(event) => update({ settingsSyncAccount: event.target.value })}
          className="max-w-[360px]"
        >
          {value === "" && <option value="">{t("settings.syncAuto")}</option>}
          {offered.map((account) => (
            <option key={account.id} value={account.id}>
              {account.email}
            </option>
          ))}
          <option value="off">{t("settings.syncOff")}</option>
        </Select>
      )}
      {syncing && <StatusLine status={status} email={syncing.email} />}
    </Row>
  );
}
