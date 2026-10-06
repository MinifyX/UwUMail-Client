import { Icon, ICONS } from "@uwusuite/design";
import { useEffect, useState } from "react";
import { LogoSymbol } from "@/components/ui/Logo";
import { useT } from "@/i18n";
import { useToasts } from "@/state/toasts";

// Most of UwUMail's notes are about a mail (archived, sent, moved), so "info" shows the envelope.
const TONE_ICONS = { info: ICONS.mail, success: ICONS.success, error: ICONS.error } as const;

/**
 * The package's toast look (inverted `toast` tokens, bottom centre, top on phones) with what only
 * UwUMail needs: a countdown until a held-back mail goes, a duration per toast, and Nyu flying off
 * with a sent mail. That is why it isn't the package's Toaster.
 */
export function Toaster() {
  const { toasts, dismiss } = useToasts();
  const { t } = useT();

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-5 left-1/2 z-[var(--uwu-z-toast)] flex w-[min(440px,calc(100vw-32px))] -translate-x-1/2 flex-col items-center gap-2 phone:top-2 phone:bottom-auto"
    >
      {toasts.map((item) => {
        return (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            className="pointer-events-auto flex w-full animate-slide-up items-center gap-3 rounded-2xl bg-toast py-2.5 pr-2 pl-4 text-meta font-medium text-toast-ink shadow-float"
          >
            <span className="relative shrink-0">
              <Icon
                icon={TONE_ICONS[item.tone]}
                size="md"
                className={item.tone === "error" ? "text-toast-danger" : "text-toast-accent"}
              />
              {item.effect === "sent" && (
                <LogoSymbol mood="happy" className="nyu-flyer pointer-events-none absolute -top-2 -left-2 h-8 w-auto" />
              )}
            </span>
            <span className="flex-1">{item.message}</span>
            {item.countdownTo && <Countdown to={item.countdownTo} />}
            {item.action && (
              <button
                type="button"
                onClick={() => {
                  dismiss(item.id);
                  item.action?.run();
                }}
                className="shrink-0 rounded-full px-3 py-1.5 text-meta font-bold text-toast-accent hover:bg-toast-ink/10"
              >
                {item.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={() => dismiss(item.id)}
              className="grid size-7 shrink-0 place-items-center rounded-full opacity-70 hover:bg-toast-ink/10 hover:opacity-100"
            >
              <Icon icon={ICONS.close} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Whole seconds left until `to`, e.g. until a held-back mail goes out. */
function Countdown({ to }: { to: string }) {
  const { i18n } = useT();
  const left = () => Math.max(0, Math.ceil((Date.parse(to) - Date.now()) / 1000));
  const [seconds, setSeconds] = useState(left);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(left()), 250);
    return () => window.clearInterval(timer);
    // `left` only reads `to`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to]);
  const text = new Intl.NumberFormat(i18n.language, { style: "unit", unit: "second", unitDisplay: "narrow" }).format(
    seconds,
  );
  return <span className="shrink-0 text-caption tabular-nums opacity-70">{text}</span>;
}
