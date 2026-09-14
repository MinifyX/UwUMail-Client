import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useT } from "@/i18n";
import { IconButton } from "./Button";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: "sm" | "md" | "lg";
  className?: string;
}

/** Modal built on <dialog>: focus trapping, Escape and backdrop come from the browser. */
export function Dialog({ open, onClose, title, children, width = "md", className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useT();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={clsx(
        "m-auto max-h-[min(720px,calc(100vh-48px))] w-[calc(100vw-48px)] overflow-hidden rounded-[22px] border border-line bg-surface p-0 text-ink shadow-float backdrop:bg-[#1c1420]/35 backdrop:backdrop-blur-[2px] open:animate-pop",
        width === "sm" && "max-w-[420px]",
        width === "md" && "max-w-[560px]",
        width === "lg" && "max-w-[860px]",
        className,
      )}
    >
      {open && (
        <div className="flex max-h-[inherit] flex-col">
          {title !== undefined && (
            <header className="flex items-center justify-between gap-4 px-6 pt-5 pb-2">
              <h2 className="text-lg font-bold">{title}</h2>
              <IconButton icon={X} label={t("common.close")} onClick={onClose} />
            </header>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      )}
    </dialog>
  );
}
