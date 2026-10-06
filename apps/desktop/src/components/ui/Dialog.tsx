import { Dialog as SuiteDialog, type DialogProps } from "@uwusuite/design";
import { useAppLock } from "@/state/lock";

/**
 * The package's Dialog, waiting while the app lock covers the window (a modal <dialog> would sit
 * above the lock). Escape in a dialog opened from another closes only that one; the package does
 * that itself.
 */
export function Dialog(props: Omit<DialogProps, "held">) {
  const locked = useAppLock((s) => s.locked);
  return <SuiteDialog {...props} held={locked} />;
}
