import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { useBackLayer } from "@/lib/backStack";
import { useUi } from "@/state/ui";
import { loadLocalDraft } from "../compose/localDraft";
import { MailboxNav } from "../mail/MailboxNav";
import { LazyCalendar } from "../shell/LazyCalendar";
import { MobileList } from "./MobileList";
import { MobileReader } from "./MobileReader";
import { EDGE_ZONE } from "./SwipeRow";

const DRAWER_WIDTH = 300;

/** The drawer with mailboxes and folders. Opens from ☰ or by swiping in from the left edge. */
function Drawer() {
  const { t } = useT();
  const open = useUi((s) => s.folderDrawerOpen);
  const setOpen = useUi((s) => s.setFolderDrawerOpen);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; id: number } | null>(null);
  useBackLayer(open, () => setOpen(false));

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30" role="presentation">
      <button
        type="button"
        aria-label={t("common.close")}
        onClick={() => setOpen(false)}
        className="absolute inset-0 animate-fade bg-[#1c1420]/40"
      />
      <div
        className={clsx(
          "absolute inset-y-0 left-0 max-w-[85vw] animate-[uwu-drawer_220ms_cubic-bezier(0.2,0.9,0.3,1)] overflow-hidden rounded-r-[24px] bg-surface shadow-float",
          drag === null && "transition-transform duration-200",
        )}
        style={{ width: DRAWER_WIDTH, transform: `translateX(${Math.min(0, drag ?? 0)}px)`, touchAction: "pan-y" }}
        onPointerDown={(event) => {
          start.current = { x: event.clientX, id: event.pointerId };
        }}
        onPointerMove={(event) => {
          if (!start.current || start.current.id !== event.pointerId) return;
          const dx = event.clientX - start.current.x;
          if (dx < -12) {
            if (drag === null) event.currentTarget.setPointerCapture(event.pointerId);
            setDrag(dx);
          }
        }}
        onPointerUp={() => {
          if (drag !== null && drag < -80) setOpen(false);
          start.current = null;
          setDrag(null);
        }}
        onPointerCancel={() => {
          start.current = null;
          setDrag(null);
        }}
      >
        {/* Taller rows for thumbs than in the desktop sidebar. */}
        <MailboxNav className="h-full pt-3 [&_.h-9]:h-11 [&_.h-9]:text-[15px]" />
      </div>
    </div>
  );
}

/** UwUMail on a phone: the list, the conversation on top of it, the drawer beside it. */
export function MobileShell() {
  const section = useUi((s) => s.section);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const selectThread = useUi((s) => s.selectThread);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const addAccountOpen = useUi((s) => s.addAccountOpen);
  const compose = useUi((s) => s.compose);
  const edge = useRef<{ x: number; y: number; id: number } | null>(null);

  useBackLayer(selectedThreadId !== null, () => selectThread(null));
  useBackLayer(settingsOpen !== null, () => useUi.getState().closeSettings());
  useBackLayer(addAccountOpen, () => useUi.getState().setAddAccountOpen(false));

  // Whatever opens on top of the drawer closes it.
  useEffect(() => {
    if (settingsOpen || addAccountOpen || compose) useUi.getState().setFolderDrawerOpen(false);
  }, [settingsOpen, addAccountOpen, compose]);

  // A draft Android didn't let us finish comes back as the bar above the write button.
  useEffect(() => {
    const saved = loadLocalDraft();
    const ui = useUi.getState();
    if (!saved || ui.compose) return;
    ui.openCompose({ mode: saved.mode, restore: saved });
    ui.setComposeMinimized(true);
  }, []);

  return (
    <div
      className="relative h-full overflow-hidden bg-surface"
      onPointerDown={(event) => {
        edge.current = event.clientX < EDGE_ZONE ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
      }}
      onPointerMove={(event) => {
        const start = edge.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x;
        if (Math.abs(event.clientY - start.y) > 40) edge.current = null;
        else if (dx > 48) {
          edge.current = null;
          useUi.getState().setFolderDrawerOpen(true);
        }
      }}
      onPointerUp={() => {
        edge.current = null;
      }}
    >
      {section === "calendar" ? (
        // The calendar brings its own drawer, which the edge swipe opens as well.
        <LazyCalendar />
      ) : (
        <>
          <MobileList />
          {selectedThreadId && (
            <div className="absolute inset-0 z-10 animate-[uwu-screen-in_220ms_cubic-bezier(0.2,0.9,0.3,1)]">
              <MobileReader key={selectedThreadId} threadId={selectedThreadId} />
            </div>
          )}
          <Drawer />
        </>
      )}
    </div>
  );
}
