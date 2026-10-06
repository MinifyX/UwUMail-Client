import { type IconProps, ICONS } from "@uwusuite/design";
import type { Account, Folder, FolderRole, MailboxView } from "@/backend/types";
import { useT } from "@/i18n";
import { useAccounts, useFolders } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { useLabelDirectory } from "../labels/useLabels";
import { useWorkspaceName } from "../workspaces/workspaces";

export const ROLE_ICONS: Record<FolderRole, IconProps["icon"]> = {
  inbox: ICONS.inbox,
  drafts: ICONS.drafts,
  sent: ICONS.send,
  archive: ICONS.archive,
  junk: ICONS.spam,
  trash: ICONS.delete,
};

export const UNIFIED_ICONS = {
  inbox: ICONS.allMailboxes,
  unread: ICONS.unread,
  flagged: ICONS.favorite,
  drafts: ICONS.drafts,
  sent: ICONS.send,
} as const;

export function folderIcon(folder: Folder): IconProps["icon"] {
  return folder.role ? ROLE_ICONS[folder.role] : ICONS.folder;
}

export function sameView(a: MailboxView, b: MailboxView): boolean {
  if (a.kind === "unified" && b.kind === "unified") return a.role === b.role;
  if (a.kind === "folder" && b.kind === "folder") return a.folderId === b.folderId;
  if (a.kind === "label" && b.kind === "label") return a.scope === b.scope && a.labelId === b.labelId;
  return false;
}

export interface ViewInfo {
  title: string;
  subtitle?: string;
  account?: Account;
  isInbox: boolean;
  /** Opening a conversation here continues the draft instead of reading it. */
  isDrafts: boolean;
  /** Deleting here means for good. */
  isTrash: boolean;
  /** Mail here is spam already, so "spam" means "not spam". */
  isJunk: boolean;
}

export function useViewInfo(view: MailboxView): ViewInfo {
  const { t } = useT();
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const workspaces = useSettings((s) => s.workspaces);
  const activeWorkspace = useSettings((s) => s.activeWorkspace);
  const workspaceName = useWorkspaceName();
  const { entries: labels } = useLabelDirectory();

  if (view.kind === "unified") {
    const title = view.role === "inbox" ? t("nav.inbox") : t(`nav.${view.role}`);
    return {
      title,
      subtitle: workspaces ? workspaceName(activeWorkspace) : accounts.length > 1 ? t("nav.unified") : undefined,
      isInbox: view.role === "inbox",
      isDrafts: view.role === "drafts",
      isTrash: false,
      isJunk: false,
    };
  }
  if (view.kind === "label") {
    const entry = labels.find((each) => each.scope === view.scope && each.label.id === view.labelId);
    const scopeAccount = accounts.find((a) => a.id === view.scope);
    return {
      title: entry?.label.name ?? t("labels.title"),
      subtitle: scopeAccount ? scopeAccount.email : t("labels.allFolders"),
      isInbox: false,
      isDrafts: false,
      isTrash: false,
      isJunk: false,
    };
  }
  const folder = folders.find((f) => f.id === view.folderId);
  const account = accounts.find((a) => a.id === view.accountId);
  return {
    title: folder?.name ?? "",
    subtitle: account?.email,
    account,
    isInbox: folder?.role === "inbox",
    isDrafts: folder?.role === "drafts",
    isTrash: folder?.role === "trash",
    isJunk: folder?.role === "junk",
  };
}
