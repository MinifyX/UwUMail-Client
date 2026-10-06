import { TitleBar, Wordmark } from "@uwusuite/design";
import { useTauriWindow } from "@uwusuite/design/tauri";
import type { MouseEvent } from "react";
import { desktopPlatform } from "@/lib/platform";

/**
 * Tauri maximizes on a double-click of a drag region by itself (its drag script), and the
 * package's title bar does it again in React: the two would cancel out. The capture phase runs
 * first and keeps the second one away. The window buttons are no drag regions, so they are never
 * touched by this. From UwUNotes.
 */
function leaveDoubleClickToTauri(event: MouseEvent) {
  if ((event.target as HTMLElement).hasAttribute("data-tauri-drag-region")) event.stopPropagation();
}

function FramelessTitleBar({ platform }: { platform: "windows" | "linux" }) {
  const controls = useTauriWindow();
  return (
    <div className="shrink-0" onDoubleClickCapture={leaveDoubleClickToTauri}>
      <TitleBar platform={platform} controls={controls} brand={<Wordmark product="Mail" shell="mail" />} />
    </div>
  );
}

/**
 * The top of the window on Windows and Linux, where it has no system frame (`decorations: false`):
 * Nyu and the word mark, a drag region, and minimize, maximize and close. Close goes through
 * `close()`, so Rust's close handler decides as for the system's button: with "keep running in the
 * background" on, the window only hides and UwUMail stays in the tray (src-tauri/src/background.rs).
 *
 * Nothing on macOS (native title bar, the menus are in the menu bar: useMacShell.ts), on phones and
 * tablets, and in a plain browser.
 */
export function WindowTitleBar() {
  if (desktopPlatform !== "windows" && desktopPlatform !== "linux") return null;
  return <FramelessTitleBar platform={desktopPlatform} />;
}
