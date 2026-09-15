import clsx from "clsx";
import { useT } from "@/i18n";
import { useFolders } from "@/lib/queries";
import { unreadInboxes, WORKSPACES } from "@/lib/workspaces";
import { useSettings } from "@/state/settings";
import { switchWorkspace, useWorkspaceName, WORKSPACE_ICONS } from "./workspaces";

interface WorkspaceSwitchProps {
  size?: "md" | "lg";
  /** On the sidebar's canvas the track takes a darker shade, so it doesn't vanish. */
  onCanvas?: boolean;
  className?: string;
}

/** Private | Business, with the other workspace's unread inbox mail. Nothing while workspaces are off. */
export function WorkspaceSwitch({ size = "md", onCanvas = false, className }: WorkspaceSwitchProps) {
  const { t } = useT();
  const enabled = useSettings((s) => s.workspaces);
  const active = useSettings((s) => s.activeWorkspace);
  const businessAccounts = useSettings((s) => s.businessAccounts);
  const { data: folders = [] } = useFolders();
  const nameOf = useWorkspaceName();
  if (!enabled) return null;

  const unread = unreadInboxes(folders, businessAccounts);
  return (
    <div
      role="radiogroup"
      aria-label={t("workspace.label")}
      className={clsx("flex shrink-0 rounded-full p-1", onCanvas ? "bg-hairline" : "bg-canvas", className)}
    >
      {WORKSPACES.map((workspace) => {
        const Icon = WORKSPACE_ICONS[workspace];
        const current = workspace === active;
        const count = current ? 0 : unread[workspace];
        return (
          <button
            key={workspace}
            type="button"
            role="radio"
            aria-checked={current}
            onClick={() => switchWorkspace(workspace)}
            className={clsx(
              "flex min-w-0 flex-1 items-center justify-center rounded-full px-2 font-semibold transition-colors",
              size === "lg" ? "h-10 gap-2.5 text-[14.5px]" : "h-8 gap-2 text-[13px]",
              current ? "bg-surface text-pink-ink shadow-sm" : "text-muted hover:text-ink",
            )}
          >
            {/* The count sits on the icon like on an app icon, so the name keeps its room in the narrow sidebar. */}
            <span className="relative shrink-0">
              <Icon className={clsx("size-4", current && "text-pink")} strokeWidth={2} aria-hidden />
              {count > 0 && (
                <span
                  aria-hidden
                  className={clsx(
                    "absolute -top-1.5 -right-2 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-pink px-1 text-[10px] leading-none font-bold text-white ring-2",
                    onCanvas ? "ring-hairline" : "ring-canvas",
                  )}
                >
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </span>
            <span className="truncate">{nameOf(workspace)}</span>
            {count > 0 && <span className="sr-only">{t("workspace.unread", { count })}</span>}
          </button>
        );
      })}
    </div>
  );
}
