import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { modKey } from "@/lib/platform";
import { WORKSPACES } from "@/lib/workspaces";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { useWorkspaceName, WORKSPACE_KEYS } from "../workspaces/workspaces";

export function KeyHint({ combo }: { combo: string }) {
  const keys = combo
    .split(/[+ ]/)
    .map((key) => (key === "mod" ? modKey : key === "Delete" ? "Del" : key === "shift" ? "⇧" : key.toUpperCase()));
  return (
    <span className="flex gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="grid h-6 min-w-6 place-items-center rounded-md border border-line bg-canvas px-1.5 font-sans text-[11.5px] font-bold text-muted"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

const SHORTCUTS: [string, string][] = [
  ["c", "compose"],
  ["/", "search"],
  ["j", "next"],
  ["k", "previous"],
  ["r", "reply"],
  ["a", "replyAll"],
  ["f", "forward"],
  ["e", "archive"],
  ["#", "trash"],
  ["v", "move"],
  ["!", "spam"],
  ["s", "flag"],
  ["u", "unread"],
  ["x", "select"],
  ["z", "undo"],
  ["g i", "goInbox"],
  ["g s", "goSent"],
  ["g d", "goDrafts"],
  ["g f", "goFlagged"],
  ["mod+Enter", "send"],
  ["mod+shift+d", "discardDraft"],
  ["mod+k", "palette"],
  ["Escape", "close"],
];

export function ShortcutsDialog() {
  const { t } = useT();
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const workspaces = useSettings((s) => s.workspaces);
  const nameOf = useWorkspaceName();
  const shortcuts = SHORTCUTS.flatMap(([combo, key]): [string, string][] => {
    const row: [string, string] = [combo, t(`shortcuts.${key}`)];
    // Switching workspaces joins the other "g" shortcuts.
    if (combo !== "g f" || !workspaces) return [row];
    return [
      row,
      ...WORKSPACES.map((workspace): [string, string] => [
        WORKSPACE_KEYS[workspace],
        t("workspace.switchTo", { name: nameOf(workspace) }),
      ]),
    ];
  });
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={t("settings.shortcuts")} width="sm">
      <ul className="flex flex-col px-6 pb-6">
        {shortcuts.map(([combo, label]) => (
          <li
            key={combo}
            className="flex h-10 items-center justify-between border-b border-hairline text-[13.5px] last:border-0"
          >
            <span>{label}</span>
            <KeyHint combo={combo === "Escape" ? "Esc" : combo} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
