import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { modKey } from "@/lib/platform";
import { WORKSPACES } from "@/lib/workspaces";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { useCalendarsAvailable } from "../calendar/useCalendarData";
import { useContactsAvailable } from "../contacts/useContactsData";
import { useWorkspaceName, WORKSPACE_KEYS } from "../workspaces/workspaces";

const KEY_LABELS: Record<string, string> = { Delete: "Del", shift: "⇧", ArrowUp: "↑", ArrowDown: "↓" };

export function KeyHint({ combo }: { combo: string }) {
  const keys = combo.split(/[+ ]/).map((key) => KEY_LABELS[key] ?? (key === "mod" ? modKey : key.toUpperCase()));
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

/** Combo, text key, and another combo doing the same. */
const SHORTCUTS: [string, string, string?][] = [
  ["c", "compose"],
  ["/", "search"],
  ["j", "next", "ArrowDown"],
  ["k", "previous", "ArrowUp"],
  ["shift+ArrowDown", "extendDown"],
  ["shift+ArrowUp", "extendUp"],
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
  ["mod+a", "selectAll"],
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

/** The calendar's own keys, while it is on screen. */
const CALENDAR_SHORTCUTS: [string, string, string?][] = [
  ["g c", "goCalendar"],
  ["t", "calendarToday"],
  ["d", "calendarDay"],
  ["w", "calendarWeek"],
  ["m", "calendarMonth"],
  ["c", "calendarNew"],
  ["n", "calendarNext", "j"],
  ["p", "calendarPrevious", "k"],
];

/** The contacts' own keys, while they are on screen. */
const CONTACT_SHORTCUTS: [string, string, string?][] = [
  ["g k", "goContacts"],
  ["c", "contactsNew"],
  ["e", "contactsEdit"],
  ["#", "contactsDelete", "Delete"],
  ["j", "contactsNext", "ArrowDown"],
  ["k", "contactsPrevious", "ArrowUp"],
  ["g m", "goMail"],
];

export function ShortcutsDialog() {
  const { t } = useT();
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcutsOpen);
  const workspaces = useSettings((s) => s.workspaces);
  const nameOf = useWorkspaceName();
  const { data: calendar = false } = useCalendarsAvailable();
  const { data: contacts = false } = useContactsAvailable();
  const shortcuts = SHORTCUTS.flatMap(([combo, key, alt]): [string, string, string?][] => {
    const row: [string, string, string?] = [combo, t(`shortcuts.${key}`), alt];
    // Switching workspaces joins the other "g" shortcuts.
    if (combo !== "g f" || !workspaces) return [row];
    return [
      row,
      ...WORKSPACES.map((workspace): [string, string, string?] => [
        WORKSPACE_KEYS[workspace],
        t("workspace.switchTo", { name: nameOf(workspace) }),
      ]),
    ];
  });
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={t("settings.shortcuts")} width="sm">
      <ShortcutList shortcuts={shortcuts} />
      {calendar && (
        <>
          <h3 className="px-6 pt-1 pb-1 text-[12px] font-bold tracking-wide text-muted uppercase">
            {t("nav.section.calendar")}
          </h3>
          <ShortcutList
            shortcuts={CALENDAR_SHORTCUTS.map(([combo, key, alt]) => [combo, t(`shortcuts.${key}`), alt])}
          />
        </>
      )}
      {contacts && (
        <>
          <h3 className="px-6 pt-1 pb-1 text-[12px] font-bold tracking-wide text-muted uppercase">
            {t("nav.section.contacts")}
          </h3>
          <ShortcutList shortcuts={CONTACT_SHORTCUTS.map(([combo, key, alt]) => [combo, t(`shortcuts.${key}`), alt])} />
        </>
      )}
    </Dialog>
  );
}

function ShortcutList({ shortcuts }: { shortcuts: [string, string, string?][] }) {
  return (
    <ul className="flex flex-col px-6 pb-6">
      {shortcuts.map(([combo, label, alt]) => (
        <li
          key={combo}
          className="flex h-10 items-center justify-between border-b border-hairline text-[13.5px] last:border-0"
        >
          <span>{label}</span>
          <span className="flex items-center gap-1.5">
            <KeyHint combo={combo === "Escape" ? "Esc" : combo} />
            {alt && (
              <>
                <span className="text-[12px] text-muted">/</span>
                <KeyHint combo={alt} />
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
