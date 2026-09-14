import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={clsx("flex flex-col items-center justify-center gap-3 px-8 py-12 text-center", className)}>
      <span className="grid size-16 animate-pop place-items-center rounded-[22px] bg-pink-tint text-pink">
        <Icon className="size-7" strokeWidth={2} aria-hidden />
      </span>
      <p className="max-w-[320px] text-[15px] font-bold text-ink">{title}</p>
      {body && <p className="max-w-[300px] text-[13px] text-muted">{body}</p>}
      {action}
    </div>
  );
}
