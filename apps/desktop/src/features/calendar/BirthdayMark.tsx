import clsx from "clsx";
import { Cake, Heart, PartyPopper } from "lucide-react";
import type { CalendarOccurrence } from "@/backend/types";

/** The cake (or heart) before a date from the contacts; nothing for other events. */
export function BirthdayMark({ occurrence, className }: { occurrence: CalendarOccurrence; className?: string }) {
  const kind = occurrence.birthday?.kind;
  if (!kind) return null;
  const Icon = kind === "birth" ? Cake : kind === "wedding" ? Heart : PartyPopper;
  return <Icon className={clsx("shrink-0", className ?? "size-3")} strokeWidth={2.25} aria-hidden />;
}
