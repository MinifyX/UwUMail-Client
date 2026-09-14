import clsx from "clsx";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { mobile } from "@/backend/mobile";
import { LogoSymbol } from "@/components/ui/Logo";
import { useT } from "@/i18n";

const ARM_AT = 72;
const MAX_PULL = 120;
const HOLD_AT = 64;
/** Nyu gets at least this long to hop, so a quick sync doesn't just flicker. */
const MIN_REFRESH_MS = 900;

interface PullToRefreshProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  onRefresh: () => Promise<unknown>;
  children: ReactNode;
}

/** Pull the list down: Nyu peeks out, lights up once it's far enough and hops while UwUMail looks for mail. */
export function PullToRefresh({ scrollRef, onRefresh, children }: PullToRefreshProps) {
  const { t } = useT();
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const start = useRef<number | null>(null);
  const armed = pull >= ARM_AT;
  const state = useRef({ pull: 0, refreshing: false });
  const refresh = useRef(onRefresh);
  useEffect(() => {
    state.current = { pull, refreshing };
    refresh.current = onRefresh;
  });

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onStart = (event: TouchEvent) => {
      if (state.current.refreshing || element.scrollTop > 0) return;
      start.current = event.touches[0]?.clientY ?? null;
      setDragging(true);
    };
    const onMove = (event: TouchEvent) => {
      if (start.current === null) return;
      const dy = (event.touches[0]?.clientY ?? start.current) - start.current;
      if (dy <= 0 || element.scrollTop > 0) {
        if (state.current.pull !== 0) setPull(0);
        return;
      }
      // Keep the page from scrolling or bouncing while Nyu is pulled.
      event.preventDefault();
      const next = Math.min(MAX_PULL, dy * 0.5);
      if (next >= ARM_AT !== state.current.pull >= ARM_AT && next >= ARM_AT) void mobile.haptic("light");
      setPull(next);
    };
    const onEnd = () => {
      if (start.current === null) return;
      start.current = null;
      setDragging(false);
      if (state.current.pull < ARM_AT) {
        setPull(0);
        return;
      }
      setRefreshing(true);
      setPull(HOLD_AT);
      const began = Date.now();
      void refresh.current().finally(() => {
        window.setTimeout(
          () => {
            setRefreshing(false);
            setPull(0);
          },
          Math.max(0, MIN_REFRESH_MS - (Date.now() - began)),
        );
      });
    };

    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onEnd);
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
    };
  }, [scrollRef]);

  const progress = Math.min(1, pull / ARM_AT);
  const label = refreshing ? t("mobile.pull.refreshing") : armed ? t("mobile.pull.release") : t("mobile.pull.pull");

  return (
    <div className="relative min-h-0 flex-1">
      <div
        aria-live="polite"
        className={clsx(
          "pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-1 overflow-hidden",
          !dragging && "transition-[height] duration-200",
        )}
        style={{ height: pull }}
      >
        {pull > 8 && (
          <>
            <span
              className="mt-2 block"
              style={{
                transform: `translateY(${(1 - progress) * -24}px) rotate(${refreshing ? 0 : (1 - progress) * -30}deg)`,
                opacity: Math.max(0.35, progress),
              }}
            >
              <LogoSymbol
                mood={refreshing ? "happy" : armed ? "sparkle" : "uwu"}
                className={clsx(
                  "h-9 w-auto",
                  refreshing && "origin-bottom animate-[nyu-hop_700ms_ease-in-out_infinite]",
                )}
              />
            </span>
            <span className="text-[11.5px] font-semibold text-muted">{label}</span>
          </>
        )}
      </div>
      <div
        className={clsx("h-full", !dragging && "transition-transform duration-200")}
        style={{ transform: `translateY(${pull}px)` }}
      >
        {children}
      </div>
    </div>
  );
}
