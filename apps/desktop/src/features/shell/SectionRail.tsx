import clsx from "clsx";
import { Icon, IconButton, ICONS, Tooltip } from "@uwusuite/design";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n";
import { accountLabel } from "@/lib/accountLabel";
import { useFolders, useVisibleAccounts } from "@/lib/queries";
import { useUi } from "@/state/ui";
import { SECTIONS, useAvailableSections } from "./AppSwitch";

/** At most this many mailboxes get their own avatar; the rest are in the sidebar. */
const MAX_AVATARS = 4;

/**
 * The column at the window's left edge, 64 px on the canvas: mail, calendar and contacts at the
 * top, the settings and one avatar per mailbox at the bottom. A click on an avatar opens that
 * mailbox's inbox. Desktop and tablet only; the phones have their tab bar.
 */
export function SectionRail({ className }: { className?: string }) {
  const { t } = useT();
  const available = useAvailableSections();
  const section = useUi((s) => s.section);
  const setSection = useUi((s) => s.setSection);
  const setView = useUi((s) => s.setView);
  const openSettings = useUi((s) => s.openSettings);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);
  const view = useUi((s) => s.view);
  const { accounts } = useVisibleAccounts();
  const { data: folders = [] } = useFolders();

  const openInbox = (accountId: string) => {
    const inbox = folders.find((f) => f.accountId === accountId && f.role === "inbox");
    setSection("mail");
    if (inbox) setView({ kind: "folder", accountId, folderId: inbox.id });
  };
  const topLevel = accounts.filter((a) => !a.parentId);

  return (
    <nav
      aria-label={t("nav.apps")}
      className={clsx("flex w-16 shrink-0 flex-col items-center gap-1.5 py-3", className)}
    >
      {SECTIONS.filter(({ id }) => available.includes(id)).map(({ id, icon }) => {
        const label = t(`nav.section.${id}`);
        const active = section === id;
        return (
          <Tooltip key={id} content={label}>
            <button
              type="button"
              aria-label={label}
              aria-current={active ? "page" : undefined}
              onClick={() => setSection(id)}
              className={clsx(
                "grid size-11 place-items-center rounded-[14px] transition-colors",
                active ? "bg-pink-tint text-pink-ink" : "text-muted hover:bg-hairline hover:text-ink",
              )}
            >
              <Icon icon={icon} size="lg" />
            </button>
          </Tooltip>
        );
      })}

      <span className="flex-1" />

      <IconButton icon={ICONS.settings} label={t("nav.settings")} onClick={() => openSettings()} />
      {topLevel.slice(0, MAX_AVATARS).map((account) => {
        const active = section === "mail" && view.kind === "folder" && view.accountId === account.id;
        const label = accountLabel(account);
        return (
          <Tooltip key={account.id} content={label}>
            <button
              type="button"
              aria-label={label}
              aria-current={active ? "true" : undefined}
              onClick={() => openInbox(account.id)}
              className={clsx(
                "grid size-11 place-items-center rounded-full transition-shadow",
                active && "ring-2 ring-pink",
              )}
            >
              <Avatar address={{ name: account.displayName || account.name, email: account.email }} size="sm" />
            </button>
          </Tooltip>
        );
      })}
      <IconButton icon={ICONS.add} label={t("nav.addAccount")} size="sm" onClick={() => setAddAccountOpen(true)} />
    </nav>
  );
}
