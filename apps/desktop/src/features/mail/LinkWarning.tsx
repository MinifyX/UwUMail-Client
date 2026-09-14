import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { openLinkNow, useLinks } from "@/state/links";

/** Asks before opening a link whose text shows a different address than where it goes. */
export function LinkWarning() {
  const { t } = useT();
  const pending = useLinks((s) => s.pending);
  const clear = useLinks((s) => s.clear);

  return (
    <Dialog open={pending !== null} onClose={clear} width="sm">
      {pending && (
        <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
          <NyuScene name="search" className="w-44" />
          <h2 className="text-[18px] font-extrabold text-balance break-keep">{t("link.warningTitle")}</h2>
          <p className="text-[13px] text-muted">{t("link.warningBody")}</p>
          <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-2xl bg-canvas px-4 py-3 text-left text-[13px]">
            <dt className="text-muted">{t("link.shown")}</dt>
            <dd className="font-semibold break-all">{pending.shown}</dd>
            <dt className="text-muted">{t("link.actual")}</dt>
            <dd className="font-extrabold break-all text-danger">{pending.actual}</dd>
          </dl>
          <p className="selectable w-full truncate text-[11.5px] text-muted" title={pending.url}>
            {pending.url}
          </p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="primary" autoFocus onClick={clear}>
              {t("link.dontOpen")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                clear();
                void openLinkNow(pending.url);
              }}
            >
              {t("link.openAnyway")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
