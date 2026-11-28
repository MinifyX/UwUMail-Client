import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { Message, PgpVerifyStatus } from "@/backend/types";
import { ICONS } from "@uwusuite/design";
import { Button } from "@uwusuite/design";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";

/**
 * Shows the automatic verification state of an inline PGP signature. It only
 * appears when the parser found a signature; verification reads the original
 * armor and checks it against keys the user imported — no network, no auto-fetch.
 */
export function PgpBadge({ message }: { message: Message }) {
  const { t } = useT();
  const [details, setDetails] = useState(false);
  const { data, isLoading, isError } = useQuery<PgpVerifyStatus>({
    queryKey: ["pgpVerify", message.id],
    queryFn: () => backend().pgpVerify(message.id),
    staleTime: 5 * 60_000,
  });
  if (!message.pgpSigned && !data) return null;

  const look = (() => {
    if (isLoading || !data) return { cls: "bg-surface text-muted", icon: ICONS.info, label: "pgp.checking" };
    if (isError) return { cls: "bg-warning-tint text-warning-ink", icon: ICONS.warning, label: "pgp.error" };
    switch (data.status) {
      case "verified":
        return { cls: "bg-success-tint text-success-ink", icon: ICONS.success, label: "pgp.verified" };
      case "unknownKey":
        return { cls: "bg-warning-tint text-warning-ink", icon: ICONS.warning, label: "pgp.unknown" };
      case "invalid":
        return { cls: "bg-danger-tint text-danger-ink", icon: ICONS.warning, label: "pgp.invalid" };
      default:
        return { cls: "bg-surface text-muted", icon: ICONS.info, label: "pgp.none" };
    }
  })();

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={`h-7 gap-1 rounded-full px-2.5 text-[12px] font-bold ${look.cls}`}
        icon={look.icon}
        onClick={() => setDetails(true)}
        title={t(look.label)}
      >
        {t(look.label)}
      </Button>
      <Dialog open={details} onClose={() => setDetails(false)} title={t("pgp.title")} width="sm">
        <div className="flex flex-col gap-2 px-6 py-4 text-[13px]">
          <p className="text-muted">{t("pgp.body")}</p>
          {data?.status === "verified" && (
            <>
              <p>
                <span className="font-semibold">{t("pgp.signer")}:</span> {data.userId || "—"}
              </p>
              <p className="selectable font-mono text-[12px] break-all">{data.fingerprint}</p>
            </>
          )}
          {data?.status === "unknownKey" && (
            <p className="text-muted">
              {t("pgp.unknownHint")}{" "}
              {data.fingerprint ? <span className="selectable font-mono text-[12px]">{data.fingerprint}</span> : ""}
            </p>
          )}
          {data?.status === "invalid" && <p className="text-danger-ink">{t("pgp.invalidHint")}</p>}
          <div className="flex justify-end pt-1">
            <Button variant="ghost" onClick={() => setDetails(false)}>
              {t("common.close")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
