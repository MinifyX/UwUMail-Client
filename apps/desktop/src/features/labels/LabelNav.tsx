import clsx from "clsx";
import { ChevronDown, ChevronRight, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import type { MailboxView } from "@/backend/types";
import { Badge, IconButton } from "@uwusuite/design";
import { useT } from "@/i18n";
import type { LabelEntry } from "@/lib/labelFilter";
import { useAccounts } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { droppedThreads, isThreadDrag } from "../mail/threadDrag";
import { sameView } from "../mail/view";
import { useLabelActions } from "./labelActions";
import { useLabelCounts, useLabelDirectory } from "./useLabels";

export function labelView(entry: LabelEntry): MailboxView {
  return {
    kind: "label",
    scope: entry.scope,
    labelId: entry.label.id,
    keyword: entry.label.keyword,
    accountIds: entry.accountIds,
  };
}

/** A label's colour as a small dot; a ring without one. */
export function LabelDot({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx("size-2.5 shrink-0 rounded-full border", !color && "border-muted", className)}
      style={color ? { backgroundColor: color, borderColor: color } : undefined}
    />
  );
}

function LabelItem({ entry, unread }: { entry: LabelEntry; unread: number }) {
  const { t } = useT();
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const { setOnThreads } = useLabelActions();
  const [dropping, setDropping] = useState(false);
  const target = labelView(entry);
  const active = sameView(view, target);
  const accepts = (event: React.DragEvent) => isThreadDrag(event.dataTransfer);

  return (
    <li>
      <button
        type="button"
        onClick={() => setView(target)}
        aria-current={active ? "page" : undefined}
        title={entry.label.description || entry.label.name}
        onDragOver={(event) => {
          if (!accepts(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          setDropping(true);
        }}
        onDragLeave={() => setDropping(false)}
        onDrop={(event) => {
          setDropping(false);
          if (!accepts(event)) return;
          event.preventDefault();
          const threadIds = droppedThreads(event.dataTransfer);
          if (threadIds.length === 0) return;
          useUi.getState().setCheckedThreadIds([]);
          void setOnThreads(threadIds, entry, true).catch(() => {});
        }}
        className={clsx(
          "flex h-8 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] transition-colors",
          dropping
            ? "bg-pink-tint-strong text-pink-ink ring-2 ring-pink"
            : active
              ? "bg-pink-tint font-semibold text-pink-ink"
              : "text-ink/85 hover:bg-pink-tint/50",
        )}
        aria-label={unread > 0 ? t("labels.navUnread", { name: entry.label.name, count: unread }) : undefined}
      >
        <span className="grid size-[17px] shrink-0 place-items-center">
          <LabelDot color={entry.label.color} />
        </span>
        <span className="min-w-0 flex-1 truncate">{entry.label.name}</span>
        {unread > 0 && <Badge count={unread} />}
      </button>
    </li>
  );
}

/**
 * The sidebar's labels, like folders: a click shows the label's mail from every folder, mail
 * dropped on one gets the label. Labels of several places (UwUMail accounts, this device) are
 * shown per place.
 */
export function LabelNav() {
  const { t } = useT();
  const { entries, loaded } = useLabelDirectory();
  const { data: counts = [] } = useLabelCounts(entries);
  const { data: accounts = [] } = useAccounts();
  const collapsed = useSettings((s) => s.labelsCollapsed);
  const update = useSettings((s) => s.update);
  const openSettings = useUi((s) => s.openSettings);
  const scopes = [...new Set(entries.map((entry) => entry.scope))];
  if (!loaded) return null;

  const placeName = (scope: string) =>
    accounts.find((account) => account.id === scope)?.email ?? t("labels.otherMailboxes");

  return (
    <section className="flex flex-col gap-0.5">
      <div className="group flex items-center">
        <button
          type="button"
          onClick={() => update({ labelsCollapsed: !collapsed })}
          aria-expanded={!collapsed}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-[12px] font-bold tracking-wide text-muted uppercase hover:text-ink"
        >
          <span className="min-w-0 flex-1 truncate text-left">{t("labels.title")}</span>
          {collapsed ? (
            <ChevronRight className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
        <IconButton
          icon={Settings2}
          size="sm"
          label={t("labels.manage")}
          onClick={() => openSettings("labels")}
          className="mr-1 size-7! opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </div>
      {!collapsed &&
        (entries.length === 0 ? (
          <button
            type="button"
            onClick={() => openSettings("labels")}
            className="flex h-8 items-center gap-3 rounded-xl px-3 text-left text-[13px] text-muted hover:bg-pink-tint/50 hover:text-ink"
          >
            <Plus className="size-[17px] shrink-0" aria-hidden />
            {t("labels.create")}
          </button>
        ) : (
          scopes.map((scope) => (
            <div key={scope} className="flex flex-col gap-0.5">
              {scopes.length > 1 && (
                <p className="truncate px-3 pt-1 text-[11.5px] font-semibold text-faint">{placeName(scope)}</p>
              )}
              <ul
                aria-label={scopes.length > 1 ? `${t("labels.title")}: ${placeName(scope)}` : t("labels.title")}
                className="flex flex-col gap-0.5"
              >
                {entries.map((entry, index) =>
                  entry.scope === scope ? (
                    <LabelItem
                      key={`${entry.scope}:${entry.label.id}`}
                      entry={entry}
                      unread={counts[index]?.unread ?? 0}
                    />
                  ) : null,
                )}
              </ul>
            </div>
          ))
        ))}
    </section>
  );
}
