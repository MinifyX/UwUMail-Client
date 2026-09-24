import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { backend } from "@/backend/backend";
import { ConfirmDiscardDialog } from "@/components/ui/ConfirmDiscardDialog";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { isAndroid, PRO_QUERY, useIsPhone, useMediaQuery } from "@/lib/device";
import { useHotkeys, type HotkeyMap } from "@/lib/hotkeys";
import { useAccounts, useBackendEvents, useIdentities, useSignatures } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { AccountSetup } from "../accounts/AccountSetup";
import { useCalendarsAvailable } from "../calendar/useCalendarData";
import { useContactsAvailable } from "../contacts/useContactsData";
import { Composer } from "../compose/Composer";
import { loadLocalDraft } from "../compose/localDraft";
import { MailboxNav } from "../mail/MailboxNav";
import { scrollReader, wantsTextSelectAll } from "../mail/readerKeys";
import { MoveDialog } from "../mail/MoveDialog";
import { MobileShell } from "../mobile/MobileShell";
import { ThreadList } from "../mail/ThreadList";
import { ThreadReader } from "../mail/ThreadReader";
import { SettingsDialog } from "../settings/SettingsDialog";
import { useWorkspaceGuard } from "../workspaces/workspaces";
import { buildCommands } from "./commands";
import { CommandPalette } from "./CommandPalette";
import { LazyCalendar } from "./LazyCalendar";
import { LazyContactDialogs, LazyContacts } from "./LazyContacts";
import { ShortcutsDialog } from "./ShortcutsDialog";

/** Keys that scroll the open mail from the list as well. */
const SCROLL_KEYS = [" ", "PageDown", "PageUp", "Home", "End"];

function AddAccountDialog() {
  const { t } = useT();
  const open = useUi((s) => s.addAccountOpen);
  const setOpen = useUi((s) => s.setAddAccountOpen);
  const [dirty, setDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const requestClose = () => {
    if (dirty) setConfirmingDiscard(true);
    else setOpen(false);
  };

  return (
    <>
      <Dialog open={open} onClose={requestClose} closeOnOutsideClick={!dirty} title={t("nav.addAccount")}>
        <div className="px-6 pt-2 pb-6">
          <AccountSetup
            onDirtyChange={setDirty}
            onDone={(account) => {
              toast(t("toast.accountAdded", { email: account.email }), "success");
              setOpen(false);
            }}
          />
        </div>
      </Dialog>
      <ConfirmDiscardDialog
        open={confirmingDiscard}
        onKeepEditing={() => setConfirmingDiscard(false)}
        onDiscard={() => {
          setConfirmingDiscard(false);
          setOpen(false);
        }}
      />
    </>
  );
}

export function MailShell() {
  const { t } = useT();
  const client = useQueryClient();
  const layout = useSettings((s) => s.layout);
  const tone = useSettings((s) => s.tone);
  const theme = useSettings((s) => s.theme);
  const workspaces = useSettings((s) => s.workspaces);
  const workspaceNames = useSettings((s) => s.workspaceNames);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const drawerOpen = useUi((s) => s.folderDrawerOpen);
  const setDrawerOpen = useUi((s) => s.setFolderDrawerOpen);
  const phone = useIsPhone();
  const roomForPro = useMediaQuery(PRO_QUERY);
  // Android tablets in portrait lack the room for three columns.
  const pro = layout === "pro" && (roomForPro || !isAndroid);
  useAccounts();
  // Loaded early, so a reply opens with the right sender address and signature.
  useIdentities();
  useSignatures();
  useBackendEvents();
  useWorkspaceGuard();

  // A draft that never reached the Drafts folder (offline, or UwUMail was closed) comes back.
  // The phone brings back every kept draft as its bar (MobileShell).
  useEffect(() => {
    if (phone) return;
    const saved = loadLocalDraft();
    const ui = useUi.getState();
    if (!saved || saved.savedToServer !== false || ui.compose) return;
    ui.openCompose({ mode: saved.mode, restore: saved });
    ui.setComposeMinimized(true);
  }, [phone]);

  const section = useUi((s) => s.section);
  const { data: calendarAvailable = false, isSuccess: calendarKnown } = useCalendarsAvailable();
  // No mailbox has calendars: the search that ran when the calendar opened found none, or the last
  // one was removed. Back to the mail.
  useEffect(() => {
    if (!calendarKnown || calendarAvailable || section !== "calendar") return;
    useUi.getState().setSection("mail");
    toast(t("calendar.noneFound"), "info");
  }, [calendarKnown, calendarAvailable, section, t]);
  const { data: contactsAvailable = false, isSuccess: contactsKnown } = useContactsAvailable();
  // Likewise for the contacts: no address book found when they opened, or the last one went.
  useEffect(() => {
    if (!contactsKnown || contactsAvailable || section !== "contacts") return;
    useUi.getState().setSection("mail");
    toast(t("contacts.noneFound"), "info");
  }, [contactsKnown, contactsAvailable, section, t]);
  // Titles depend on tone, theme, layout and the workspaces, so rebuild when they change.
  const commands = useMemo(
    () => buildCommands(client, t, { calendar: calendarAvailable, contacts: contactsAvailable }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      client,
      t,
      layout,
      tone,
      theme,
      selectedThreadId,
      workspaces,
      workspaceNames,
      calendarAvailable,
      contactsAvailable,
    ],
  );

  const hotkeys = useMemo(() => {
    const map: HotkeyMap = {
      "mod+k": () => useUi.getState().setPaletteOpen(true),
      // The simple layout only hides the list while a mail is open, so j/k step through it there too.
      j: () => useUi.getState().selectRelative(1),
      k: () => useUi.getState().selectRelative(-1),
      Escape: () => {
        const ui = useUi.getState();
        if (ui.folderDrawerOpen) ui.setFolderDrawerOpen(false);
        else if (ui.checkedThreadIds.length > 0) ui.setCheckedThreadIds([]);
        else if (ui.selectedThreadId) ui.selectThread(null);
      },
    };
    for (const command of commands) {
      for (const key of command.keys ?? []) map[key] = () => void command.run();
    }
    // The phone keeps its own gestures and selection; these belong to the list and reader side by side.
    if (phone) {
      delete map["mod+a"];
    } else {
      // Always the mail above or below, also while reading; with Shift they tick a range instead.
      map.ArrowDown = (event) => {
        const ui = useUi.getState();
        if (event.shiftKey) ui.extendSelection(1);
        else ui.selectRelative(1);
      };
      map.ArrowUp = (event) => {
        const ui = useUi.getState();
        if (event.shiftKey) ui.extendSelection(-1);
        else ui.selectRelative(-1);
      };
      // Ticks what the list has loaded, unless the user means the text in a field or the mail.
      map["mod+a"] = (event) => {
        const ui = useUi.getState();
        if (wantsTextSelectAll(event) || ui.visibleThreadIds.length === 0) return false;
        ui.checkAllVisible();
      };
      for (const key of SCROLL_KEYS) map[key] = scrollReader;
    }
    return map;
  }, [commands, phone]);
  // The calendar and the contacts bring their own keys.
  useHotkeys(hotkeys, { enabled: section === "mail", repeat: ["j", "k", "ArrowDown", "ArrowUp", ...SCROLL_KEYS] });

  return (
    <div className="flex h-full flex-col">
      {backend().kind === "demo" && (
        <p className="shrink-0 bg-pink-tint py-1 text-center text-[12px] font-semibold text-pink-ink">
          {t("status.demo")}
        </p>
      )}

      {phone ? (
        <MobileShell />
      ) : section === "calendar" ? (
        <LazyCalendar />
      ) : section === "contacts" ? (
        <LazyContacts />
      ) : pro ? (
        // A minmax(0,1fr) row keeps the columns at window height so each one scrolls on its own.
        <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(320px,420px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
          <MailboxNav workspaceSwitch className="min-h-0 bg-canvas" />
          <ThreadList variant="pro" className="min-h-0 border-x border-hairline" />
          <ThreadReader variant="pro" className="min-h-0" />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 gap-3 p-3">
          <ThreadList
            variant="simple"
            className={clsx(
              "rounded-[22px] border border-hairline",
              selectedThreadId
                ? "hidden w-[380px] shrink-0 lg:flex"
                : "w-full max-w-[560px] shrink-0 max-lg:max-w-none",
            )}
          />
          <ThreadReader
            variant="simple"
            className={clsx(
              "min-w-0 flex-1 overflow-hidden rounded-[22px] border border-hairline",
              !selectedThreadId && "max-lg:hidden",
            )}
          />

          {drawerOpen && (
            <div className="absolute inset-0 z-30 flex" role="presentation">
              <button
                type="button"
                aria-label={t("common.close")}
                onClick={() => setDrawerOpen(false)}
                className="absolute inset-0 animate-fade bg-[#1c1420]/30"
              />
              <MailboxNav className="relative w-[280px] animate-slide-up rounded-r-[22px] bg-surface shadow-float" />
            </div>
          )}
        </div>
      )}

      <Composer />
      <SettingsDialog />
      <LazyContactDialogs />
      <AddAccountDialog />
      <CommandPalette commands={commands} />
      <ShortcutsDialog />
      <MoveDialog />
    </div>
  );
}
