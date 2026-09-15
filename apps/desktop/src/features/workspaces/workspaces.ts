import { BriefcaseBusiness, House, type LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { useT } from "@/i18n";
import { workspaceOf } from "@/lib/workspaces";
import { useSettings, type Workspace } from "@/state/settings";
import { useUi } from "@/state/ui";

export const WORKSPACE_ICONS: Record<Workspace, LucideIcon> = { private: House, business: BriefcaseBusiness };

/** "g p" and "g b", next to "g i" for the inbox. */
export const WORKSPACE_KEYS: Record<Workspace, string> = { private: "g p", business: "g b" };

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** A workspace's own name, or "Private" and "Business" in the app's language. */
export function workspaceName(workspace: Workspace, names: Record<Workspace, string>, t: Translate) {
  return names[workspace].trim() || t(`workspace.${workspace}`);
}

export function useWorkspaceName() {
  const { t } = useT();
  const names = useSettings((s) => s.workspaceNames);
  return (workspace: Workspace) => workspaceName(workspace, names, t);
}

/** Shows the other workspace. Folders and conversations belong to one mailbox, so they close; unified views stay. */
export function switchWorkspace(workspace: Workspace) {
  const settings = useSettings.getState();
  if (!settings.workspaces || settings.activeWorkspace === workspace) return;
  settings.update({ activeWorkspace: workspace });
  const ui = useUi.getState();
  ui.setView(ui.view.kind === "folder" ? { kind: "unified", role: "inbox" } : ui.view);
}

/** A folder of a mailbox that isn't in the active workspace (any more) gives way to the inbox. Mount once. */
export function useWorkspaceGuard() {
  const view = useUi((s) => s.view);
  const hidden = useSettings(
    (s) =>
      s.workspaces && view.kind === "folder" && workspaceOf(view.accountId, s.businessAccounts) !== s.activeWorkspace,
  );
  useEffect(() => {
    if (hidden) useUi.getState().setView({ kind: "unified", role: "inbox" });
  }, [hidden]);
}
