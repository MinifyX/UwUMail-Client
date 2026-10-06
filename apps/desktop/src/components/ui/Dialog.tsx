import type { HTMLAttributes, SyntheticEvent } from "react";
import { Dialog as SuiteDialog, type DialogProps } from "@uwusuite/design";
import { useAppLock } from "@/state/lock";

// React types onCancel for <dialog> only, but hands it to every element on the way up.
const keepCancel = {
  onCancel: (event: SyntheticEvent) => event.stopPropagation(),
} as HTMLAttributes<HTMLDivElement>;

/**
 * The package's Dialog with UwUMail's two additions:
 * - it waits while the app lock covers the window (a modal <dialog> would sit above the lock);
 * - Escape in a dialog opened from another dialog closes only that one: React hands the nested
 *   dialog's `cancel` up the component tree, so it stops here, at the dialog it belongs to.
 */
export function Dialog(props: Omit<DialogProps, "held">) {
  const locked = useAppLock((s) => s.locked);
  return (
    <div className="contents" {...keepCancel}>
      <SuiteDialog {...props} held={locked} />
    </div>
  );
}
