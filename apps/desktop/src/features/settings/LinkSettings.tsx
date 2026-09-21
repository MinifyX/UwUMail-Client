import clsx from "clsx";
import { Link2, X } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { useSettings } from "@/state/settings";
import { Row } from "./Row";

/** "Ask before opening links" and the sites whose links open without asking. */
export function LinkSettings() {
  const { t } = useT();
  const linkConfirm = useSettings((s) => s.linkConfirm);
  const linkDomains = useSettings((s) => s.linkDomains);
  const update = useSettings((s) => s.update);
  const forgetLinkDomains = useSettings((s) => s.forgetLinkDomains);
  const domains = [...linkDomains].sort();

  return (
    <>
      <div className="border-b border-hairline py-4">
        <Toggle
          checked={linkConfirm}
          onChange={(checked) => update({ linkConfirm: checked })}
          label={t("settings.linkConfirm")}
          description={t("settings.linkConfirmDesc")}
        />
      </div>
      <Row label={t("settings.linkDomains")} description={t("settings.linkDomainsDesc")}>
        {!linkConfirm && domains.length > 0 && (
          <p className="text-[12.5px] text-warning">{t("settings.linkDomainsInactive")}</p>
        )}
        {domains.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
            {t("settings.linkDomainsEmpty")}
          </p>
        ) : (
          <ul
            className={clsx(
              "flex max-h-56 flex-col overflow-y-auto rounded-2xl border border-hairline p-1",
              !linkConfirm && "opacity-60",
            )}
          >
            {domains.map((domain) => (
              <li key={domain} className="flex items-center gap-3 rounded-xl py-1 pr-1 pl-3 hover:bg-elevated">
                <Link2 className="size-4 shrink-0 text-faint" aria-hidden />
                <span className="selectable min-w-0 flex-1 truncate text-[13.5px] font-semibold">{domain}</span>
                <IconButton
                  icon={X}
                  size="sm"
                  label={t("settings.forgetLinkDomain", { domain })}
                  onClick={() => forgetLinkDomains([domain])}
                />
              </li>
            ))}
          </ul>
        )}
      </Row>
    </>
  );
}
