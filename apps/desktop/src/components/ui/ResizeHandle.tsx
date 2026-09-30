import { useRef } from "react";
import { PANE_LIMITS, PANE_STEP, usePaneWidths, type Pane } from "@/lib/paneWidths";

interface ResizeHandleProps {
  pane: Pane;
  /** The width the pane is drawn at right now (it may be narrower than saved on a small window). */
  width: number;
  label: string;
}

/**
 * The border between two columns, dragged to resize the one on its left. A focusable separator:
 * ←/→ change the width, Home/End jump to the limits, Enter or a double-click goes back to the start.
 */
export function ResizeHandle({ pane, width, label }: ResizeHandleProps) {
  const setWidth = usePaneWidths((s) => s.setWidth);
  const reset = usePaneWidths((s) => s.reset);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const { min, max } = PANE_LIMITS[pane];

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        setWidth(pane, drag.current.startWidth + event.clientX - drag.current.startX);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => reset(pane)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? PANE_STEP * 10 : PANE_STEP;
        const next =
          event.key === "ArrowLeft"
            ? width - step
            : event.key === "ArrowRight"
              ? width + step
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : event.key === "Enter"
                    ? PANE_LIMITS[pane].initial
                    : null;
        if (next === null) return;
        // The list keys (↑/↓, Home/End) must not also run.
        event.preventDefault();
        event.stopPropagation();
        setWidth(pane, next);
      }}
      className="group relative z-10 -mx-[3px] w-[7px] shrink-0 cursor-col-resize touch-none outline-none"
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-[3px] w-px bg-hairline transition-colors group-hover:w-[3px] group-hover:-translate-x-px group-hover:bg-pink-tint-strong group-focus-visible:w-[3px] group-focus-visible:-translate-x-px group-focus-visible:bg-pink"
      />
    </div>
  );
}
