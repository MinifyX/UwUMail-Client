import clsx from "clsx";
import { Archive, MailCheck, MailOpen, Star, Trash } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { mobile } from "@/backend/mobile";
import { LogoSymbol } from "@/components/ui/Logo";
import { useT } from "@/i18n";
import type { SwipeAction } from "@/state/settings";

/** Past this share of the row width, letting go runs the action. */
const THRESHOLD = 0.3;
/** Touches this close to the left edge open the drawer instead. */
export const EDGE_ZONE = 28;
const LONG_PRESS_MS = 450;

const LOOKS: Record<Exclude<SwipeAction, "none">, { icon: LucideIcon; className: string }> = {
  read: { icon: MailCheck, className: "bg-[var(--uwu-account-violet)]" },
  archive: { icon: Archive, className: "bg-pink-solid" },
  trash: { icon: Trash, className: "bg-danger" },
  flag: { icon: Star, className: "bg-[var(--uwu-account-amber)]" },
};

interface SwipeRowProps {
  children: ReactNode;
  /** Runs when swiping right, revealed on the left. */
  right: SwipeAction;
  /** Runs when swiping left, revealed on the right. */
  left: SwipeAction;
  /** The thread is unread, so "read" marks it read instead of unread. */
  unread: boolean;
  onSwipe: (action: Exclude<SwipeAction, "none">) => void;
  onLongPress: () => void;
  /** In selection mode taps select and nothing swipes. */
  selecting: boolean;
}

type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  width: number;
  mode: "undecided" | "swipe" | "scroll";
  armed: boolean;
};

export function SwipeRow({ children, right, left, unread, onSwipe, onLongPress, selecting }: SwipeRowProps) {
  const { t } = useT();
  const [offset, setOffset] = useState(0);
  const [leaving, setLeaving] = useState<"left" | "right" | null>(null);
  const [armed, setArmed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  const pressTimer = useRef<number | null>(null);
  const swallowClick = useRef(false);

  const stopPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const reset = () => {
    gesture.current = null;
    stopPress();
    setDragging(false);
    setOffset(0);
    setArmed(false);
  };

  const side = offset > 0 ? right : left;
  const look = side !== "none" ? LOOKS[side] : null;
  const label =
    side === "read"
      ? t(unread ? "mobile.swipe.read" : "mobile.swipe.unread")
      : side !== "none"
        ? t(`mobile.swipe.${side}`)
        : "";
  const Icon = side === "read" && !unread ? MailOpen : look?.icon;

  return (
    <div
      className="relative overflow-hidden rounded-2xl"
      onClickCapture={(event) => {
        if (swallowClick.current) {
          event.preventDefault();
          event.stopPropagation();
          swallowClick.current = false;
        }
      }}
    >
      {offset !== 0 && look && Icon && (
        <div
          aria-hidden
          className={clsx(
            "absolute inset-0 flex items-center gap-2 px-6 text-[13px] font-bold text-white transition-opacity",
            look.className,
            offset > 0 ? "justify-start" : "justify-end",
            armed ? "opacity-100" : "opacity-75",
          )}
        >
          {offset < 0 && <span>{label}</span>}
          <span className={clsx("relative transition-transform duration-150", armed && "scale-125")}>
            <Icon className="size-5" strokeWidth={2.4} />
            <LogoSymbol key={String(armed)} hop={armed ? 1 : 0} className="absolute -top-3.5 -right-3.5 h-4 w-auto" />
          </span>
          {offset > 0 && <span>{label}</span>}
        </div>
      )}
      <div
        style={{
          transform: `translateX(${leaving === "right" ? "100%" : leaving === "left" ? "-100%" : `${offset}px`})`,
          touchAction: "pan-y",
        }}
        className={clsx("relative bg-surface", (!dragging || leaving) && "transition-transform duration-200 ease-out")}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          gesture.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            width: event.currentTarget.offsetWidth,
            mode: selecting || event.clientX < EDGE_ZONE ? "scroll" : "undecided",
            armed: false,
          };
          stopPress();
          pressTimer.current = window.setTimeout(() => {
            pressTimer.current = null;
            if (gesture.current?.mode === "swipe") return;
            swallowClick.current = true;
            void mobile.haptic("medium");
            onLongPress();
          }, LONG_PRESS_MS);
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          const dx = event.clientX - current.x;
          const dy = event.clientY - current.y;
          if (Math.abs(dx) > 8 || Math.abs(dy) > 8) stopPress();
          if (current.mode === "undecided") {
            if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) {
              current.mode = "swipe";
              setDragging(true);
              event.currentTarget.setPointerCapture(event.pointerId);
            } else if (Math.abs(dy) > 12) {
              current.mode = "scroll";
            }
          }
          if (current.mode !== "swipe") return;
          const action = dx > 0 ? right : left;
          if (action === "none") {
            setOffset(dx * 0.15);
            return;
          }
          const limit = current.width * 0.6;
          const eased = Math.sign(dx) * Math.min(Math.abs(dx), limit + (Math.abs(dx) - limit) * 0.25);
          setOffset(Math.abs(dx) > limit ? eased : dx);
          const nowArmed = Math.abs(dx) > current.width * THRESHOLD;
          if (nowArmed !== current.armed) {
            current.armed = nowArmed;
            setArmed(nowArmed);
            if (nowArmed) void mobile.haptic("light");
          }
        }}
        onPointerUp={(event) => {
          const current = gesture.current;
          if (!current || current.pointerId !== event.pointerId) return;
          if (current.mode === "swipe") {
            swallowClick.current = true;
            const action = offset > 0 ? right : left;
            if (current.armed && action !== "none") {
              const direction = offset > 0 ? "right" : "left";
              // "Read" and "flag" keep the row in place; the others slide it away.
              if (action === "archive" || action === "trash") setLeaving(direction);
              window.setTimeout(
                () => {
                  onSwipe(action);
                  setLeaving(null);
                },
                action === "archive" || action === "trash" ? 180 : 0,
              );
            }
          }
          reset();
        }}
        onPointerCancel={reset}
      >
        {children}
      </div>
    </div>
  );
}
