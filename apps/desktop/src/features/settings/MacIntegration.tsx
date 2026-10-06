import { Button, ICONS, Toggle } from "@uwusuite/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { backend, type MacIntegration as Integration } from "@/backend/backend";
import { useT } from "@/i18n";
import { toast } from "@/state/toasts";
import { Row } from "./Row";

const KEY = ["macIntegration"];

/**
 * macOS: what the DMG's setup does, from inside the app — the default mail app, and in the App
 * Store build (no setup there) opening at login. Nothing elsewhere: the backend answers null.
 */
export function MacIntegration() {
  const { t } = useT();
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: KEY, queryFn: () => backend().macIntegration() });
  if (!data) return null;

  const apply = async (change: () => Promise<Integration | null>, done?: string) => {
    try {
      const next = await change();
      client.setQueryData(KEY, next);
      if (done) toast(done, "success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : String(reason), "error");
      void client.invalidateQueries({ queryKey: KEY });
    }
  };

  return (
    <>
      <Row label={t("settings.mac.defaultMail")} description={t("settings.mac.defaultMailDesc")}>
        {data.defaultMail ? (
          <p className="text-[13px] font-semibold text-pink-ink">{t("settings.mac.isDefaultMail")}</p>
        ) : (
          <Button
            size="sm"
            icon={ICONS.mail}
            className="self-start"
            onClick={() => void apply(() => backend().macMakeDefaultMail(), t("settings.mac.madeDefaultMail"))}
          >
            {t("settings.mac.makeDefaultMail")}
          </Button>
        )}
      </Row>
      {data.loginItem !== null && (
        <div className="flex flex-col gap-2 border-b border-hairline py-4">
          <Toggle
            checked={data.loginItem !== "off"}
            onChange={(enabled) => void apply(() => backend().macSetLoginItem(enabled))}
            label={t("settings.mac.loginItem")}
            description={t(
              data.loginItem === "approval" ? "settings.mac.loginItemApproval" : "settings.mac.loginItemDesc",
            )}
          />
        </div>
      )}
    </>
  );
}
