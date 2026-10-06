import { useQuery, useQueryClient } from "@tanstack/react-query";
import { mobile, type PushStatus } from "@/backend/mobile";
import { Select, Toggle } from "@uwusuite/design";
import { useT } from "@/i18n";

export const PUSH_STATUS_KEY = ["pushStatus"];

/** What the settings say about the accounts, or nothing while there is nothing to say. */
function progress(status: PushStatus, t: ReturnType<typeof useT>["t"]): string | null {
  const app = status.distributors.find((distributor) => distributor.id === status.distributor)?.name ?? "";
  if (!status.active) return status.distributors.length === 0 ? t("settings.unifiedPushGone") : null;
  const accounts = status.accounts;
  if (!accounts) return null;
  if (status.working || accounts.waiting > 0) return t("settings.unifiedPushWaiting", { app });
  if (accounts.active === 0) return t("settings.unifiedPushNone");
  if (accounts.other === 0) return t("settings.unifiedPushAll", { app });
  return t("settings.unifiedPushPartly", { app, count: accounts.active });
}

/**
 * Android: new mail for JMAP accounts through a UnifiedPush distributor app, so UwUMail doesn't
 * have to keep its own connection (and its lasting notification) for them. Shown when a
 * distributor is installed, or while it is switched on.
 */
export function UnifiedPush() {
  const { t } = useT();
  const client = useQueryClient();
  const { data: status } = useQuery({
    queryKey: PUSH_STATUS_KEY,
    queryFn: () => mobile.pushStatus(),
    // Registering takes a moment: look again until no account is waiting anymore.
    refetchInterval: (query) => {
      const current = query.state.data;
      return current?.active && (current.working || (current.accounts?.waiting ?? 0) > 0) ? 4000 : false;
    },
  });
  if (!status || (status.distributors.length === 0 && !status.enabled)) return null;

  const change = async (enabled: boolean, distributor: string | null) => {
    const next = await mobile.setUnifiedPush(enabled, distributor).catch(() => null);
    if (next) client.setQueryData(PUSH_STATUS_KEY, next);
    else void client.invalidateQueries({ queryKey: PUSH_STATUS_KEY });
  };
  const message = status.enabled ? progress(status, t) : null;

  return (
    <div className="flex flex-col gap-2 pt-2">
      <Toggle
        checked={status.enabled}
        onChange={(enabled) => void change(enabled, status.distributor)}
        label={t("settings.unifiedPush")}
        description={t("settings.unifiedPushDesc")}
      />
      {status.enabled && status.distributors.length > 1 && (
        <Select
          aria-label={t("settings.unifiedPushApp")}
          value={status.distributor ?? ""}
          onChange={(event) => void change(true, event.target.value)}
          className="max-w-[240px]"
        >
          {status.distributor === null && (
            <option value="" disabled>
              {t("settings.unifiedPushPick")}
            </option>
          )}
          {status.distributors.map((distributor) => (
            <option key={distributor.id} value={distributor.id}>
              {distributor.name}
            </option>
          ))}
        </Select>
      )}
      {message && (
        <p className="text-[13px] text-muted" role="status">
          {message}
        </p>
      )}
      {status.enabled && status.active && status.failed > 0 && (
        <p className="text-[13px] text-muted">{t("settings.unifiedPushFailed")}</p>
      )}
    </div>
  );
}
