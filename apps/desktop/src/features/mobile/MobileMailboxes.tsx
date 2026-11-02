import { Badge, GroupedList, ListRow, ListSection, Screen, type MobilePlatform } from "@uwusuite/design";
import type { ReactNode } from "react";
import type { MailboxView } from "@/backend/types";
import { useT } from "@/i18n";
import { accountLabel } from "@/lib/accountLabel";
import { resolveRefs } from "@/lib/arrangement";
import { useFolders, useVisibleAccounts } from "@/lib/queries";
import { topLevel, useUnifiedTally } from "@/state/arrangement";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { LabelDot, labelView } from "../labels/LabelNav";
import { useLabelCounts, useLabelDirectory } from "../labels/useLabels";
import { buildFolderTree, countsUnread, type FolderNode } from "../mail/folderTree";
import { folderIcon, folderLabel, UNIFIED_ICONS } from "../mail/view";
import { WorkspaceSwitch } from "../workspaces/WorkspaceSwitch";

const UNIFIED_ROLES = ["inbox", "unread", "flagged", "drafts", "sent"] as const;

function flatten(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/**
 * The mail tab's root on phones: every mailbox and folder as grouped lists, instead of a drawer.
 * Picking one pushes its list (`onOpen`).
 */
export function MobileMailboxes({
  platform,
  leading,
  trailing,
  onOpen,
}: {
  platform: MobilePlatform;
  leading?: ReactNode;
  trailing?: ReactNode;
  onOpen: (view: MailboxView) => void;
}) {
  const { t } = useT();
  const { accounts } = useVisibleAccounts();
  const { data: allFolders = [] } = useFolders();
  const order = useSettings((s) => s.accountsOrder);
  const favoriteRefs = useSettings((s) => s.favoriteFolders);
  const tally = useUnifiedTally();
  const { entries } = useLabelDirectory();
  const { data: labelCounts = [] } = useLabelCounts(entries);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);

  const folders = allFolders.filter((f) => accounts.some((account) => account.id === f.accountId));
  const unreadInboxes = folders
    .filter((f) => !tally.leftOut.includes(f.accountId))
    .filter((f) => f.role === "inbox" || tally.extraFolderIds.includes(f.id))
    .reduce((sum, f) => sum + f.unread, 0);
  const favorites = resolveRefs(favoriteRefs, accounts, folders).filter((folder) => folder.selectable);
  const count = (n: number | undefined) => (n ? <Badge count={n} /> : undefined);

  return (
    <Screen title={t("mobile.mailboxes")} largeTitle leading={leading} trailing={trailing} platform={platform}>
      <div className="px-4 pb-2">
        <WorkspaceSwitch size="lg" />
      </div>
      <GroupedList platform={platform} className="pb-32">
        <ListSection header={accounts.length > 1 ? t("nav.unified") : undefined}>
          {UNIFIED_ROLES.map((role) => (
            <ListRow
              key={role}
              icon={UNIFIED_ICONS[role]}
              iconTone="pink"
              title={t(`nav.${role}`)}
              trailing={role === "inbox" ? count(unreadInboxes) : undefined}
              onClick={() => onOpen({ kind: "unified", role })}
            />
          ))}
        </ListSection>

        {favorites.length > 0 && (
          <ListSection header={t("nav.favorites")}>
            {favorites.map((folder) => {
              const account = accounts.find((each) => each.id === folder.accountId);
              return (
                <ListRow
                  key={folder.id}
                  icon={folderIcon(folder)}
                  iconTone="neutral"
                  title={folderLabel(folder, t)}
                  subtitle={accounts.length > 1 && account ? accountLabel(account) : undefined}
                  trailing={countsUnread(folder) ? count(folder.unread) : undefined}
                  onClick={() => onOpen({ kind: "folder", accountId: folder.accountId, folderId: folder.id })}
                />
              );
            })}
          </ListSection>
        )}

        {topLevel(accounts, order).map((account) => (
          <ListSection key={account.id} header={accountLabel(account)}>
            {flatten(buildFolderTree(folders.filter((f) => f.accountId === account.id)))
              .filter(({ folder }) => folder.selectable)
              .map(({ folder, depth }) => (
                <ListRow
                  key={folder.id}
                  icon={folderIcon(folder)}
                  iconTone="neutral"
                  title={
                    depth > 0 ? `${" ".repeat(Math.min(depth, 3))}${folderLabel(folder, t)}` : folderLabel(folder, t)
                  }
                  trailing={countsUnread(folder) ? count(folder.unread) : undefined}
                  onClick={() => onOpen({ kind: "folder", accountId: account.id, folderId: folder.id })}
                />
              ))}
          </ListSection>
        ))}

        {entries.length > 0 && (
          <ListSection header={t("labels.title")}>
            {entries.map((entry, index) => (
              <ListRow
                key={`${entry.scope}:${entry.label.id}`}
                icon={<LabelDot color={entry.label.color} />}
                title={entry.label.name}
                trailing={count(labelCounts[index]?.unread)}
                onClick={() => onOpen(labelView(entry))}
              />
            ))}
          </ListSection>
        )}

        <ListSection>
          <ListRow tone="accent" title={t("nav.addAccount")} onClick={() => setAddAccountOpen(true)} />
        </ListSection>
      </GroupedList>
    </Screen>
  );
}
