import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIsPhone } from "@/lib/device";
import type { Anchor } from "./state";

const WIDTH = 360;
const GAP = 10;

interface PopoverProps {
  anchor: Anchor;
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A card beside what was clicked (an event, a slot), or a sheet from the bottom on a phone.
 * Escape and a click elsewhere close it; focus moves in and goes back afterwards.
 */
export function Popover({ anchor, label, onClose, children }: PopoverProps) {
  const phone = useIsPhone();
  const card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useLayoutEffect(() => {
    if (phone || !card.current) return;
    const height = card.current.offsetHeight;
    const right = anchor.left + anchor.width + GAP;
    const left = right + WIDTH <= window.innerWidth - 8 ? right : Math.max(8, anchor.left - WIDTH - GAP);
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8));
    setPosition({ left, top });
  }, [anchor, phone]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const first = card.current?.querySelector<HTMLElement>("[data-autofocus], input, button");
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
      event.stopPropagation();
      close.current();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element;
      if (card.current?.contains(target) || target.closest?.("[role=menu], dialog[open]")) return;
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return createPortal(
    <div
      ref={card}
      role="dialog"
      aria-label={label}
      // Unmeasured it stays see-through, not hidden: hidden elements can't take the focus.
      style={phone ? undefined : (position ?? { left: anchor.left, top: anchor.top, opacity: 0 })}
      className={clsx(
        "fixed z-40 flex animate-pop flex-col border border-line bg-surface text-ink shadow-float",
        phone
          ? "inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-[24px] pb-[max(16px,env(safe-area-inset-bottom))]"
          : "max-h-[calc(100vh-16px)] w-[360px] overflow-y-auto rounded-[20px]",
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
