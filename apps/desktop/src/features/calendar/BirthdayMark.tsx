import clsx from "clsx";
import { Icon, ICONS } from "@uwusuite/design";
import type { CalendarOccurrence } from "@/backend/types";

/** The cake (or heart) before a date from the contacts; nothing for other events. */
export function BirthdayMark({ occurrence, className }: { occurrence: CalendarOccurrence; className?: string }) {
  const kind = occurrence.birthday?.kind;
  if (!kind) return null;
  const Glyph = kind === "birth" ? ICONS.birthday : kind === "wedding" ? ICONS.anniversary : ICONS.celebration;
  return <Icon icon={Glyph} size="xs" className={clsx("shrink-0", className ?? "")} />;
}
