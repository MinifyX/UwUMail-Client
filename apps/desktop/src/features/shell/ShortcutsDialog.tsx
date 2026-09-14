import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { modKey } from "@/lib/platform";
import { useUi } from "@/state/ui";

export function KeyHint({ combo }: { combo: string }) {
  const keys = combo.split("+").map((key) => (key === "mod" ? modKey : key === "Delete" ? "Del" : key.toUpperCase()));
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
  ["s", "flag"],
  ["u", "unread"],
  ["mod+k", "palette"],
  ["Escape", "close"],
];

export function ShortcutsDialog() {
  const { t } = useT();
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={t("settings.shortcuts")} width="sm">
      <ul className="flex flex-col px-6 pb-6">
        {SHORTCUTS.map(([combo, key]) => (
          <li
            key={combo}
            className="flex h-10 items-center justify-between border-b border-hairline text-[13.5px] last:border-0"
          >
            <span>{t(`shortcuts.${key}`)}</span>
            <KeyHint combo={combo === "Escape" ? "Esc" : combo} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
