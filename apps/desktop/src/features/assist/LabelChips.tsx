import clsx from "clsx";
import { Button, Icon, ICONS, Menu } from "@uwusuite/design";
import { useEffect, useId, useRef, useState } from "react";
import { backend } from "@/backend/backend";
import type { AssistLabel, AssistLabelLogEntry, Message } from "@/backend/types";
import { useT } from "@/i18n";
import { formatLongDate } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { chipStyle, labelReason, labelsOff, labelsOn, setByAssistant } from "./labels";
import {
  AssistForAccount,
  assistErrorText,
  providerLabel,
  useAssistLabels,
  useAssistScope,
  useLabelLog,
} from "./useAssist";

/** Puts a label's keyword on a mail or takes it off, then shows the change. */
function useSetKeyword() {
  const client = useQueryClient();
  return (messageId: string, keyword: string, on: boolean) =>
    backend()
      .setKeywords([messageId], { [keyword]: on })
      .then(() => {
        void client.invalidateQueries({ queryKey: queryKeys.threads });
        void client.invalidateQueries({ queryKey: queryKeys.thread });
      })
      .catch((error: unknown) => {
        toast(assistErrorText(error), "error");
        throw error;
      });
}

/** One label as a small rounded chip, in its colour. */
function Chip({ label, size = "md" }: { label: AssistLabel; size?: "sm" | "md" }) {
  return (
    <span
      style={chipStyle(label.color)}
      className={clsx(
        "inline-flex max-w-[12rem] min-w-0 items-center gap-1 rounded-full border font-semibold",
        !label.color && "border-line bg-canvas text-muted",
        size === "sm" ? "h-[18px] px-1.5 text-[10.5px]" : "h-6 px-2 text-[11.5px]",
      )}
    >
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** The labels of a conversation in the list: the first two, and how many more. */
export function ListLabelChips({ keywords }: { keywords: string[] | undefined }) {
  const { t } = useT();
  const { data: labels = [] } = useAssistLabels();
  const on = labelsOn(keywords, labels);
  if (on.length === 0) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1"
      aria-label={t("assist.labels.on", { names: on.map((label) => label.name).join(", ") })}
    >
      {on.slice(0, 2).map((label) => (
        <Chip key={label.id} label={label} size="sm" />
      ))}
      {on.length > 2 && <span className="text-[10.5px] font-semibold text-muted">+{on.length - 2}</span>}
    </span>
  );
}

/** A conversation's labels in the list, in the scope of its mailbox; nothing without keywords. */
export function ThreadLabelChips({ accountId, keywords }: { accountId: string | undefined; keywords?: string[] }) {
  if (!accountId || !keywords || keywords.length === 0) return null;
  return (
    <AssistForAccount accountId={accountId}>
      <ListLabelChips keywords={keywords} />
    </AssistForAccount>
  );
}

interface MessageLabelsProps {
  message: Message;
  /** Keywords may be set on it (own mail, or a shared folder that allows it). */
  canEdit: boolean;
}

/**
 * The labels on one mail in the reader. A label the assistant set says why when clicked and can
 * be undone there; any label can be taken off, and one of the person's labels put on by hand.
 */
export function MessageLabels({ message, canEdit }: MessageLabelsProps) {
  const { t } = useT();
  const { data: labels = [] } = useAssistLabels();
  const on = labelsOn(message.keywords, labels);
  const { data: log = [] } = useLabelLog(message.id, on.length > 0);
  const setKeyword = useSetKeyword();
  const off = labelsOff(message.keywords, labels);

  if (labels.length === 0 || (on.length === 0 && !canEdit)) return null;

  const put = (label: AssistLabel) =>
    void setKeyword(message.id, label.keyword, true).then(() =>
      toast(t("assist.labels.added", { name: label.name }), "success"),
    );

  return (
    <div className="-mt-1 flex flex-wrap items-center gap-1.5">
      {on.map((label) => (
        <LabelChip
          key={label.id}
          label={label}
          message={message}
          entry={setByAssistant(log, message.id, label.keyword)}
          canEdit={canEdit}
        />
      ))}
      {canEdit && off.length > 0 && (
        <Menu
          items={off.map((label) => ({
            label: (
              <span className="flex items-center gap-2.5">
                <span
                  className="size-2.5 shrink-0 rounded-full border border-line"
                  style={label.color ? { backgroundColor: label.color, borderColor: label.color } : undefined}
                  aria-hidden
                />
                {label.name}
              </span>
            ),
            onSelect: () => put(label),
          }))}
          trigger={(menu) => (
            <button
              type="button"
              onClick={menu.toggle}
              aria-haspopup={menu["aria-haspopup"]}
              aria-expanded={menu["aria-expanded"]}
              aria-controls={menu["aria-controls"]}
              title={t("assist.labels.add")}
              aria-label={t("assist.labels.add")}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-line px-2 text-[11.5px] font-semibold text-muted hover:border-pink hover:text-pink-ink focus-visible:shadow-focus focus-visible:outline-none"
            >
              {on.length === 0 ? <Icon icon={ICONS.label} size="xs" /> : <Icon icon={ICONS.add} size="xs" />}
              {on.length === 0 && t("assist.labels.addShort")}
            </button>
          )}
        />
      )}
    </div>
  );
}

/** A label chip that opens a small card: why the assistant set it, and undo or remove. */
function LabelChip({
  label,
  message,
  entry,
  canEdit,
}: {
  label: AssistLabel;
  message: Message;
  entry: AssistLabelLogEntry | null;
  canEdit: boolean;
}) {
  const { t, i18n } = useT();
  const scope = useAssistScope();
  const setKeyword = useSetKeyword();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const undo = () => {
    if (!entry) return;
    setBusy(true);
    backend()
      .undoAssistLabels(scope, [entry.id])
      .then(() => {
        setOpen(false);
        toast(t("assist.labels.undone", { name: label.name }), "success");
      })
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => setBusy(false));
  };

  const remove = () => {
    setOpen(false);
    void setKeyword(message.id, label.keyword, false).then(() =>
      toast(t("assist.labels.removed", { name: label.name }), "success"),
    );
  };

  return (
    <span ref={root} className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        title={entry ? t("assist.labels.whyTitle") : label.description || label.name}
        className="inline-flex items-center rounded-full focus-visible:shadow-focus focus-visible:outline-none"
      >
        <Chip label={label} />
        {entry &&
          (entry.source === "ai" ? (
            <Icon
              icon={ICONS.ai}
              size="xs"
              className="-ml-1.5 shrink-0 text-pink"
              label={t("assist.labels.byAssistant")}
            />
          ) : (
            <Icon
              icon={ICONS.automatic}
              size="xs"
              className="-ml-1.5 shrink-0 text-pink"
              label={t("labels.chip.automatic")}
            />
          ))}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label.name}
          className="absolute top-[calc(100%+6px)] left-0 z-40 flex w-[min(320px,calc(100vw-48px))] animate-pop flex-col gap-2 rounded-2xl border border-line bg-surface p-3 text-ink shadow-float"
        >
          <div className="flex items-center gap-2">
            <Chip label={label} />
            <button
              type="button"
              aria-label={t("assist.labels.closeWhy")}
              onClick={() => setOpen(false)}
              className="ml-auto grid size-6 place-items-center rounded-full text-muted hover:bg-pink-tint hover:text-pink-ink"
            >
              <Icon icon={ICONS.close} size="xs" />
            </button>
          </div>
          {label.description && <p className="text-[12.5px] text-muted">{label.description}</p>}
          {entry ? (
            <div className="flex flex-col gap-1 rounded-xl bg-pink-tint/40 px-3 py-2">
              <p className="flex items-center gap-1.5 text-[12px] font-bold text-pink-ink">
                {entry.source === "ai" ? <Icon icon={ICONS.ai} size="xs" /> : <Icon icon={ICONS.automatic} size="xs" />}
                {entry.source === "ai"
                  ? t("assist.labels.byAssistant")
                  : t("labels.chip.bySource", { source: t(`labels.source.${entry.source}`) })}
              </p>
              {labelReason(entry, t) && <p className="selectable text-[13px]">{labelReason(entry, t)}</p>}
              <p className="text-[11.5px] text-muted">
                {[
                  entry.providerName ? providerLabel({ providerName: entry.providerName, model: entry.model }) : null,
                  formatLongDate(entry.createdAt, i18n.language),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-[12px] text-muted">
              <Icon icon={ICONS.done} size="xs" />
              {t("assist.labels.byHand")}
            </p>
          )}
          {canEdit && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {entry ? (
                <Button size="sm" variant="primary" icon={ICONS.undo} busy={busy} onClick={undo}>
                  {t("assist.labels.undo")}
                </Button>
              ) : (
                <Button size="sm" icon={ICONS.close} onClick={remove}>
                  {t("assist.labels.remove")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
