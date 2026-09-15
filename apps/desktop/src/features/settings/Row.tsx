import type { ReactNode } from "react";

/** One setting: a label, an optional explanation and its control. */
export function Row({
  label,
  description,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 border-b border-hairline py-4 last:border-0">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        {description && <p className="text-[13px] text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
