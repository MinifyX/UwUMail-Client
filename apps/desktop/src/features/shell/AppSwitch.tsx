import clsx from "clsx";
import { CalendarDays, Mail, UsersRound } from "lucide-react";
import { useT } from "@/i18n";
import { useUi, type AppSection } from "@/state/ui";
import { useCalendarsAvailable } from "../calendar/useCalendarData";
import { useContactsAvailable } from "../contacts/useContactsData";

const SECTIONS: { id: AppSection; icon: typeof Mail }[] = [
  { id: "mail", icon: Mail },
  { id: "calendar", icon: CalendarDays },
  { id: "contacts", icon: UsersRound },
];

/** The sections some account offers besides mail. */
export function useAvailableSections(): AppSection[] {
  const { data: calendar = false } = useCalendarsAvailable();
  const { data: contacts = false } = useContactsAvailable();
  return SECTIONS.map((s) => s.id).filter(
    (id) => id === "mail" || (id === "calendar" && calendar) || (id === "contacts" && contacts),
  );
}

/**
 * Mail, calendar or contacts, at the top of the sidebar. Only there when an account has more than
 * mail. On the sidebar's canvas the track takes a darker shade, so it doesn't vanish.
 */
export function AppSwitch({ onCanvas = false }: { onCanvas?: boolean }) {
  const { t } = useT();
  const available = useAvailableSections();
  const section = useUi((s) => s.section);
  const setSection = useUi((s) => s.setSection);
  if (available.length < 2) return null;
  const three = available.length === 3;
  return (
    <div
      role="tablist"
      aria-label={t("nav.apps")}
      className={clsx(
        "grid gap-1 p-1",
        three ? "grid-cols-3 rounded-[18px]" : "grid-cols-2 rounded-full",
        onCanvas ? "bg-hairline" : "bg-canvas",
      )}
    >
      {SECTIONS.filter(({ id }) => available.includes(id)).map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={section === id}
          onClick={() => setSection(id)}
          className={clsx(
            // Three don't fit side by side with their names; then the name goes under the icon.
            three
              ? "flex h-12 min-w-0 flex-col items-center justify-center gap-0.5 rounded-[14px] px-1 text-[11.5px] font-semibold transition-colors"
              : "flex h-8 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition-colors",
            section === id ? "bg-surface text-pink-ink shadow-sm" : "text-muted hover:text-ink",
          )}
        >
          <Icon className="size-4 shrink-0" strokeWidth={2.2} aria-hidden />
          <span className="max-w-full truncate">{t(`nav.section.${id}`)}</span>
        </button>
      ))}
    </div>
  );
}
