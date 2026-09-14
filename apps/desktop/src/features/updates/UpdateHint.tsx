import { ChevronDown } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { backend } from "@/backend/backend";
import { nativeAndroid } from "@/backend/mobile";
import { Button } from "@/components/ui/Button";
import { LogoSymbol } from "@/components/ui/Logo";
import { useT } from "@/i18n";
import { toast } from "@/state/toasts";
import { notesFor, useUpdates } from "@/state/updates";

/** Nyu's quiet note that a new version is downloaded and ready. */
export function UpdateHint() {
  const { t, i18n } = useT();
  const { ready, dismissed, dismiss } = useUpdates();
  const [showNotes, setShowNotes] = useState(false);
  const [restarting, setRestarting] = useState(false);
  if (!ready || dismissed) return null;

  const notes = notesFor(ready.notes, i18n.language);
  return (
    <aside
      aria-live="polite"
      className="fixed right-5 bottom-5 z-40 w-[min(340px,calc(100vw-32px))] animate-slide-up rounded-[20px] border border-hairline bg-elevated p-4 shadow-float max-[699px]:right-3 max-[699px]:bottom-24"
    >
      <div className="flex gap-3">
        <LogoSymbol mood="sparkle" hop={1} className="h-11 w-auto shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-[14px] font-extrabold">{t("update.readyTitle")}</p>
          <p className="text-[12.5px] text-muted">
            {t("update.version", { version: ready.version })}
            {notes && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setShowNotes(!showNotes)}
                  aria-expanded={showNotes}
                  className="inline-flex items-center gap-0.5 font-semibold text-pink-ink hover:underline"
                >
                  {t("update.whatsNew")}
                  <ChevronDown
                    className={clsx("size-3.5 transition-transform", showNotes && "rotate-180")}
                    aria-hidden
                  />
                </button>
              </>
            )}
          </p>
        </div>
      </div>
      {showNotes && (
        <p className="selectable mt-3 max-h-40 overflow-y-auto rounded-xl bg-canvas px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-line">
          {notes}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={dismiss}>
          {t("update.later")}
        </Button>
        <Button
          size="sm"
          variant="primary"
          busy={restarting}
          onClick={async () => {
            setRestarting(true);
            try {
              await backend().installUpdate();
            } catch (reason) {
              setRestarting(false);
              toast(reason instanceof Error ? reason.message : String(reason), "error");
            }
          }}
        >
          {t(nativeAndroid ? "update.install" : "update.restart")}
        </Button>
      </div>
    </aside>
  );
}
