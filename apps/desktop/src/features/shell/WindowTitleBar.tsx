import { TitleBar, Wordmark } from "@uwusuite/design";
import { useTauriWindow } from "@uwusuite/design/tauri";
import type { MouseEvent } from "react";
import { desktopPlatform } from "@/lib/platform";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { MailSearch } from "../mail/MailSearch";

/** Windows and Linux search from the title bar; macOS keeps its native one and the list's field. */
export const searchInTitleBar = desktopPlatform === "windows" || desktopPlatform === "linux";

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
  const onboarded = useSettings((s) => s.onboarded);
  const section = useUi((s) => s.section);
  return (
    <div className="shrink-0" onDoubleClickCapture={leaveDoubleClickToTauri}>
      <TitleBar
        platform={platform}
        controls={controls}
        className="relative"
        brand={<Wordmark product="Mail" shell="mail" />}
      >
        {/* Centred over the whole bar; the empty space around the field stays a drag region. */}
        {onboarded && section === "mail" && (
          <div className="pointer-events-none absolute inset-y-0 left-1/2 flex w-[420px] max-w-[40%] -translate-x-1/2 items-center">
            <MailSearch compact className="pointer-events-auto w-full" />
          </div>
        )}
      </TitleBar>
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
