import clsx from "clsx";
import type { ReactNode } from "react";
import { useNyuLevel } from "./level";
import { Nyu, NYU, Sticker } from "./Nyu";

interface NyuThinkingProps {
  /**
   * `md` (default): Nyu with a thought bubble, for "thinking…" rows next to a text.
   * `sm`: Nyu alone, bobbing, the size of an icon, e.g. in a busy button.
   */
  size?: "sm" | "md";
  /** What shows while Nyu's animations are off (the setting "off"). */
  fallback?: ReactNode;
  className?: string;
}

/**
 * Nyu thinks while the AI works: it looks up and around, a thought bubble fills with dots.
 * Decorative (aria-hidden); put the words ("Thinking…") next to it. Still when reduced.
 */
export function NyuThinking({ size = "md", fallback = null, className }: NyuThinkingProps) {
  const level = useNyuLevel();
  if (level === "off") return <>{fallback}</>;
  if (size === "sm") {
    return (
      <svg
        viewBox="56 40 400 388"
        className={clsx("nyu-host nyu-thinking nyu-thinking-sm size-4 shrink-0 overflow-visible", className)}
        strokeLinecap="round"
        strokeLinejoin="round"
        data-testid="nyu-thinking"
        aria-hidden
        focusable="false"
      >
        <g className="nyu-think-bob">
          <Nyu mood="happy" tilt={-6} />
        </g>
      </svg>
    );
  }
  return (
    <svg
      viewBox="-8 14 252 150"
      className={clsx("nyu-host nyu-thinking h-8 w-auto shrink-0 overflow-visible", className)}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-testid="nyu-thinking"
      aria-hidden
      focusable="false"
    >
      <g className="nyu-think-bob">
        <Nyu mood="happy" x={70} y={108} scale={0.4} tilt={-4} />
      </g>
      <Sticker edge={14}>
        <circle cx="136" cy="96" r="7" fill={NYU.paper} stroke={NYU.ink} strokeWidth={5} />
        <circle cx="152" cy="76" r="10" fill={NYU.paper} stroke={NYU.ink} strokeWidth={5} />
        <path
          d="M160 58 Q156 26 190 28 Q206 12 224 28 Q248 30 240 56 Q248 80 220 82 Q204 96 186 82 Q156 84 160 58Z"
          fill={NYU.paper}
          stroke={NYU.ink}
          strokeWidth={5}
        />
      </Sticker>
      <g fill={NYU.body}>
        <circle className="nyu-think-dot" cx="182" cy="56" r="7" />
        <circle className="nyu-think-dot" cx="202" cy="56" r="7" style={{ animationDelay: "180ms" }} />
        <circle className="nyu-think-dot" cx="222" cy="56" r="7" style={{ animationDelay: "360ms" }} />
      </g>
    </svg>
  );
}
