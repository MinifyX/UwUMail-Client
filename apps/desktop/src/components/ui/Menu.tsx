import clsx from "clsx";
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: ReactNode;
  onSelect: () => void;
  /** Deletes or throws away something. */
  danger?: boolean;
}

interface MenuProps {
  /** Renders the button that opens the menu. */
  trigger: (props: {
    open: boolean;
    toggle: () => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
  }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  /** Opens upwards, e.g. from a toolbar at the bottom. */
  side?: "below" | "above";
  className?: string;
  /** Opens and closes it from outside too, e.g. from a right-click on the row the menu belongs to. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** A small popup list of actions. Closes on selection, Escape and clicks outside. */
export function Menu({
  trigger,
  items,
  align = "start",
  side = "below",
  className,
  open: controlled,
  onOpenChange,
}: MenuProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const setOpen = (value: boolean) => {
    setUncontrolled(value);
    onOpenChange?.(value);
  };
  const close = useEffectEvent(() => setOpen(false));
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Only the menu closes, not the mail or dialog behind it.
      event.stopPropagation();
      close();
      root.current?.querySelector<HTMLButtonElement>("[aria-haspopup]")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const moveFocus = (step: number) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div ref={root} className={clsx("relative inline-flex", className)}>
      {trigger({
        open,
        toggle: () => setOpen(!open),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": id,
      })}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(event.key === "ArrowDown" ? 1 : -1);
            }
          }}
          className={clsx(
            "absolute z-40 flex w-max max-w-[min(360px,calc(100vw-48px))] min-w-[200px] animate-pop flex-col rounded-2xl border border-line bg-surface p-1.5 text-ink shadow-float",
            side === "above" ? "bottom-[calc(100%+6px)]" : "top-[calc(100%+6px)]",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {items.map((item, index) => (
            <button
              key={index}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={clsx(
                "rounded-xl px-3 py-2 text-left text-[13px] font-medium break-words hover:bg-pink-tint/60 focus:bg-pink-tint/60 focus:outline-none",
                item.danger && "text-danger",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
