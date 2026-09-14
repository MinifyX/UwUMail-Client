import clsx from "clsx";
import { ChevronDown, PenLine, Plus, Settings } from "lucide-react";
import { useState } from "react";
import type { Account, Folder, MailboxView } from "@/backend/types";
import { AccountDot } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Wordmark } from "@/components/ui/Logo";
import { Badge } from "@/components/ui/Pill";
import { useT } from "@/i18n";
import { useAccounts, useFolders } from "@/lib/queries";
import { useUi } from "@/state/ui";
import { folderIcon, sameView, UNIFIED_ICONS } from "./view";
import type { LucideIcon } from "lucide-react";

const UNIFIED_ROLES = ["inbox", "unread", "flagged", "drafts", "sent"] as const;
const ROLE_ORDER = ["inbox", "drafts", "sent", "archive", "junk", "trash"];

function sortFolders(folders: Folder[]) {
  return [...folders].sort((a, b) => {
    const ra = a.role ? ROLE_ORDER.indexOf(a.role) : ROLE_ORDER.length;
    const rb = b.role ? ROLE_ORDER.indexOf(b.role) : ROLE_ORDER.length;
    return ra - rb || a.name.localeCompare(b.name);
  });
}

interface NavItemProps {
  icon: LucideIcon;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}

function NavItem({ icon: Icon, label, count, active, onClick }: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "group flex h-9 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] transition-colors",
        active ? "bg-pink-tint font-semibold text-pink-ink" : "text-ink/85 hover:bg-pink-tint/50",
      )}
    >
      <Icon className={clsx("size-[17px] shrink-0", active ? "text-pink" : "text-muted")} strokeWidth={2} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && <Badge count={count} />}
    </button>
  );
}

function AccountSection({ account, folders }: { account: Account; folders: Folder[] }) {
  const [open, setOpen] = useState(true);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);

  return (
    <section className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex h-8 items-center gap-2 rounded-lg px-3 text-[12px] font-bold tracking-wide text-muted uppercase hover:text-ink"
      >
        <AccountDot color={account.color} />
        <span className="min-w-0 flex-1 truncate text-left tracking-normal normal-case">{account.email}</span>
        <ChevronDown className={clsx("size-3.5 transition-transform", !open && "-rotate-90")} aria-hidden />
      </button>
      {open &&
        sortFolders(folders).map((folder) => {
          const target: MailboxView = { kind: "folder", accountId: account.id, folderId: folder.id };
          return (
            <NavItem
              key={folder.id}
              icon={folderIcon(folder)}
              label={folder.name}
              count={folder.role === "inbox" || folder.role === null ? folder.unread : undefined}
              active={sameView(view, target)}
              onClick={() => setView(target)}
            />
          );
        })}
    </section>
  );
}

export function MailboxNav({ className }: { className?: string }) {
  const { t } = useT();
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const openCompose = useUi((s) => s.openCompose);
  const openSettings = useUi((s) => s.openSettings);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);

  const unreadInboxes = folders.filter((f) => f.role === "inbox").reduce((sum, f) => sum + f.unread, 0);

  return (
    <nav className={clsx("flex h-full flex-col gap-4 px-3 pt-4 pb-3", className)}>
      <div className="flex items-center justify-between px-2">
        <Wordmark className="text-[19px]" />
      </div>

      <Button
        variant="primary"
        size="lg"
        icon={PenLine}
        onClick={() => openCompose({ mode: "new" })}
        className="w-full"
      >
        {t("nav.compose")}
      </Button>

      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
        <section className="flex flex-col gap-0.5">
          {accounts.length > 1 && (
            <p className="px-3 pb-1 text-[12px] font-bold tracking-wide text-muted uppercase">{t("nav.unified")}</p>
          )}
          {UNIFIED_ROLES.map((role) => {
            const target: MailboxView = { kind: "unified", role };
            return (
              <NavItem
                key={role}
                icon={UNIFIED_ICONS[role]}
                label={t(`nav.${role}`)}
                count={role === "inbox" ? unreadInboxes : undefined}
                active={sameView(view, target)}
                onClick={() => setView(target)}
              />
            );
          })}
        </section>

        {accounts.map((account) => (
          <AccountSection
            key={account.id}
            account={account}
            folders={folders.filter((f) => f.accountId === account.id)}
          />
        ))}
      </div>

      <div className="flex flex-col gap-0.5 border-t border-hairline pt-3">
        <NavItem icon={Plus} label={t("nav.addAccount")} active={false} onClick={() => setAddAccountOpen(true)} />
        <NavItem icon={Settings} label={t("nav.settings")} active={false} onClick={() => openSettings()} />
      </div>
    </nav>
  );
}
