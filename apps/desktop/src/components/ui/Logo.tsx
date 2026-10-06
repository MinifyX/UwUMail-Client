import clsx from "clsx";
import { Nyu, type NyuMood } from "@uwusuite/design";

interface LogoSymbolProps {
  /** Sets the height (`h-11`); the width follows. */
  className?: string;
  title?: string;
  mood?: NyuMood;
  /** Changing this number makes Nyu hop once, e.g. when new mail arrives. */
  hop?: number;
}

/**
 * UwUMail's Nyu, the envelope cat, on her own: the update hint, the About page, the swipe and pull
 * gestures, the flying Nyu of the "sent" toast. The wordmark is the package's `Wordmark`.
 */
export function LogoSymbol({ className, title, mood, hop = 0 }: LogoSymbolProps) {
  return (
    <span key={hop} className={clsx("nyu-logo inline-flex", hop > 0 && "nyu-logo-hop", className)}>
      <Nyu shell="mail" mood={mood} size="100%" blink={false} title={title ?? ""} />
    </span>
  );
}
