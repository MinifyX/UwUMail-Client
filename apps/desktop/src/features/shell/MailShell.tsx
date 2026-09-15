import clsx from "clsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { backend } from "@/backend/backend";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { isAndroid, PRO_QUERY, useIsPhone, useMediaQuery } from "@/lib/device";
import { useHotkeys, type HotkeyMap } from "@/lib/hotkeys";
import { useAccounts, useBackendEvents } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { AccountSetup } from "../accounts/AccountSetup";
import { Composer } from "../compose/Composer";
import { loadLocalDraft } from "../compose/localDraft";
import { MailboxNav } from "../mail/MailboxNav";
import { MobileShell } from "../mobile/MobileShell";
import { ThreadList } from "../mail/ThreadList";
import { ThreadReader } from "../mail/ThreadReader";
import { SettingsDialog } from "../settings/SettingsDialog";
import { buildCommands } from "./commands";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsDialog } from "./ShortcutsDialog";

function AddAccountDialog() {
  const { t } = useT();
  const open = useUi((s) => s.addAccountOpen);
  const setOpen = useUi((s) => s.setAddAccountOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={t("nav.addAccount")}>
      <div className="px-6 pt-2 pb-6">
        <AccountSetup
          onDone={(account) => {
            toast(t("toast.accountAdded", { email: account.email }), "success");
            setOpen(false);
          }}
        />
      </div>
    </Dialog>
  );
}

export function MailShell() {
  const { t } = useT();
  const client = useQueryClient();
  const layout = useSettings((s) => s.layout);
  const tone = useSettings((s) => s.tone);
  const theme = useSettings((s) => s.theme);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const drawerOpen = useUi((s) => s.folderDrawerOpen);
  const setDrawerOpen = useUi((s) => s.setFolderDrawerOpen);
  const phone = useIsPhone();
  const roomForPro = useMediaQuery(PRO_QUERY);
  // Android tablets in portrait lack the room for three columns.
  const pro = layout === "pro" && (roomForPro || !isAndroid);
  useAccounts();
  useBackendEvents();

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

  // Titles depend on tone, theme and layout, so rebuild when they change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const commands = useMemo(() => buildCommands(client, t), [client, t, layout, tone, theme, selectedThreadId]);

  const hotkeys = useMemo(() => {
    const map: HotkeyMap = {
      "mod+k": () => useUi.getState().setPaletteOpen(true),
      Escape: () => {
        const ui = useUi.getState();
        if (ui.folderDrawerOpen) ui.setFolderDrawerOpen(false);
        else if (ui.selectedThreadId) ui.selectThread(null);
      },
    };
    if (layout === "pro") {
      map.j = () => useUi.getState().selectRelative(1);
      map.k = () => useUi.getState().selectRelative(-1);
    }
    for (const command of commands) {
      for (const key of command.keys ?? []) map[key] = () => void command.run();
    }
    return map;
  }, [commands, layout]);
  useHotkeys(hotkeys);

  return (
    <div className="flex h-full flex-col">
      {backend().kind === "demo" && (
        <p className="shrink-0 bg-pink-tint py-1 text-center text-[12px] font-semibold text-pink-ink">
          {t("status.demo")}
        </p>
      )}

      {phone ? (
        <MobileShell />
      ) : pro ? (
        // A minmax(0,1fr) row keeps the columns at window height so each one scrolls on its own.
        <div className="grid min-h-0 flex-1 grid-cols-[240px_minmax(320px,420px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
          <MailboxNav className="min-h-0 bg-canvas" />
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
      <AddAccountDialog />
      <CommandPalette commands={commands} />
      <ShortcutsDialog />
    </div>
  );
}
