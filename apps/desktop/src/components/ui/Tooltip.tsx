import clsx from "clsx";
import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  /** The text shown on hover and keyboard focus. */
  content: string;
  children: ReactNode;
  className?: string;
  /** Runs on click or tap, e.g. to show more details on touch screens where there is no hover. */
  onActivate?: () => void;
}

/**
 * A small tooltip for a piece of inline text. The trigger is focusable, so the tooltip is
 * reachable by keyboard, and it describes the trigger for screen readers. It is drawn above
 * everything else, so a truncated line around the trigger doesn't cut it off.
 */
export function Tooltip({ content, children, className, onActivate }: TooltipProps) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 240)), top: rect.bottom + 4 });
  };
  const hide = () => setPosition(null);

  return (
    <>
      <span
        ref={trigger}
        role={onActivate ? "button" : undefined}
        tabIndex={0}
        aria-describedby={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={onActivate}
        onKeyDown={(event) => {
          if (event.key === "Escape") hide();
          if (onActivate && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            onActivate();
          }
        }}
        // A name is picked by whoever sent the mail: its direction marks stay inside it and
        // can't turn the names around it (security-audit W-21).
        className={clsx(
          "rounded outline-none [unicode-bidi:isolate] focus-visible:shadow-focus",
          onActivate && "cursor-pointer",
          className,
        )}
      >
        {children}
      </span>
      {createPortal(
        <span
          id={id}
          role="tooltip"
          style={position ?? undefined}
          className={clsx(
            "pointer-events-none fixed z-50 w-max max-w-[min(360px,calc(100vw-16px))] rounded-lg bg-ink px-2.5 py-1 text-[12px] font-medium break-all text-canvas shadow-float",
            !position && "hidden",
          )}
        >
          {content}
        </span>,
        document.body,
      )}
    </>
  );
}
