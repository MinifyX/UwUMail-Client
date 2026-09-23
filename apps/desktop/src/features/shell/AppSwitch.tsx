import clsx from "clsx";
import { CalendarDays, Mail } from "lucide-react";
import { useT } from "@/i18n";
import { useUi, type AppSection } from "@/state/ui";
import { useCalendarsAvailable } from "../calendar/useCalendarData";

const SECTIONS: { id: AppSection; icon: typeof Mail }[] = [
  { id: "mail", icon: Mail },
  { id: "calendar", icon: CalendarDays },
];

/**
 * Mail or calendar, at the top of the sidebar. Only there when an account has calendars. On the
 * sidebar's canvas the track takes a darker shade, so it doesn't vanish.
 */
export function AppSwitch({ onCanvas = false }: { onCanvas?: boolean }) {
  const { t } = useT();
  const { data: available } = useCalendarsAvailable();
  const section = useUi((s) => s.section);
  const setSection = useUi((s) => s.setSection);
  if (!available) return null;
  return (
    <div
      role="tablist"
      aria-label={t("nav.apps")}
      className={clsx("grid grid-cols-2 gap-1 rounded-full p-1", onCanvas ? "bg-hairline" : "bg-canvas")}
    >
      {SECTIONS.map(({ id, icon: Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={section === id}
          onClick={() => setSection(id)}
          className={clsx(
            "flex h-8 items-center justify-center gap-1.5 rounded-full text-[13px] font-semibold transition-colors",
            section === id ? "bg-surface text-pink-ink shadow-sm" : "text-muted hover:text-ink",
          )}
        >
          <Icon className="size-4" strokeWidth={2.2} aria-hidden />
          {t(`nav.section.${id}`)}
        </button>
      ))}
    </div>
  );
}
