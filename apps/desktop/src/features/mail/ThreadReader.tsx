import clsx from "clsx";
import {
  Archive,
  ArrowLeft,
  FolderInput,
  Forward,
  MailOpen,
  RefreshCw,
  Reply,
  ReplyAll,
  ShieldAlert,
  ShieldCheck,
  Star,
  Trash,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Message } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n";
import { inTrash, useAccounts, useFolders, useMessageActions, useThread } from "@/lib/queries";
import { useUi } from "@/state/ui";
import { MessageView } from "./MessageView";
import { requestMove } from "./selection";

interface ThreadReaderProps {
  variant: "simple" | "pro";
  className?: string;
}

/** Messages that start expanded: the newest one plus every unread one. */
function initiallyExpanded(messages: Message[]) {
  const ids = new Set(messages.filter((m) => !m.flags.seen).map((m) => m.id));
  const last = messages[messages.length - 1];
  if (last) ids.add(last.id);
  return ids;
}

export function ThreadReader({ variant, className }: ThreadReaderProps) {
  const { t } = useT();
  const threadId = useUi((s) => s.selectedThreadId);
  const selectThread = useUi((s) => s.selectThread);
  const openCompose = useUi((s) => s.openCompose);
  const { data, isPending, isError, refetch, isRefetching } = useThread(threadId);
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const actions = useMessageActions();
  const messages = data?.messages;
  const loadedThreadId = data?.thread.id;

  // Snapshot per thread: marking messages as read must not collapse them again.
  const initial = useMemo(
    () => (messages ? initiallyExpanded(messages) : new Set<string>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadedThreadId],
  );
  const [opened, setOpened] = useState<{ threadId: string; ids: Set<string> } | null>(null);
  const expanded = opened && opened.threadId === loadedThreadId ? opened.ids : initial;
  const expand = (ids: string[]) => {
    if (loadedThreadId) setOpened({ threadId: loadedThreadId, ids: new Set([...expanded, ...ids]) });
  };

  useEffect(() => {
    if (!messages) return;
    const unseen = messages.filter((m) => !m.flags.seen).map((m) => m.id);
    if (unseen.length > 0) void actions.setFlags(unseen, { seen: true });
    // Only when a different thread finished loading, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedThreadId]);

  if (!threadId) {
    return (
      <section className={clsx("flex h-full items-center justify-center bg-canvas", className)}>
        <EmptyState
          scene="pick"
          compact={variant === "pro"}
          title={t("reader.empty.title")}
          body={t("reader.empty.body")}
        />
      </section>
    );
  }

  if (isError && !data) {
    return (
      <section className={clsx("flex h-full items-center justify-center bg-canvas", className)}>
        <EmptyState
          scene="loadError"
          compact={variant === "pro"}
          title={t("reader.error.title")}
          body={t("reader.error.body")}
          action={
            <Button icon={RefreshCw} busy={isRefetching} onClick={() => void refetch()}>
              {t("reader.error.retry")}
            </Button>
          }
        />
      </section>
    );
  }

  if (isPending || !data) {
    return (
      <section className={clsx("flex h-full items-center justify-center bg-canvas text-[13px] text-muted", className)}>
        {t("reader.loading")}
      </section>
    );
  }

  const all = data.messages;
  const latest = all[all.length - 1]!;
  const ids = all.map((m) => m.id);
  const flagged = data.thread.flagged;
  const hiddenCount = all.filter((m) => !expanded.has(m.id)).length;
  const inJunk = all.every((m) => folders.find((f) => f.id === m.folderId)?.role === "junk");
  const trashed = inTrash(all, folders);

  return (
    <section className={clsx("flex h-full min-w-0 flex-col bg-canvas", className)} aria-label={data.thread.subject}>
      <header className="flex items-center gap-1 border-b border-hairline bg-surface px-3 py-2">
        {variant === "simple" && (
          <IconButton icon={ArrowLeft} label={t("reader.back")} onClick={() => selectThread(null)} className="mr-1" />
        )}
        <IconButton
          icon={Reply}
          label={t("reader.reply")}
          onClick={() => openCompose({ mode: "reply", source: latest })}
        />
        <IconButton
          icon={ReplyAll}
          label={t("reader.replyAll")}
          onClick={() => openCompose({ mode: "replyAll", source: latest })}
        />
        <IconButton
          icon={Forward}
          label={t("reader.forward")}
          onClick={() => openCompose({ mode: "forward", source: latest })}
        />
        <span className="mx-1.5 h-5 w-px bg-line" aria-hidden />
        <IconButton
          icon={Archive}
          label={t("reader.archive")}
          onClick={() => void actions.archive(ids).then(() => selectThread(null))}
        />
        <IconButton
          icon={Trash}
          label={trashed ? t("reader.deleteForever") : t("reader.trash")}
          onClick={() => void actions.trash(all).then((gone) => gone && selectThread(null))}
        />
        <IconButton
          icon={FolderInput}
          label={t("reader.move")}
          onClick={() => requestMove(all, () => selectThread(null))}
        />
        <IconButton
          icon={inJunk ? ShieldCheck : ShieldAlert}
          label={inJunk ? t("reader.notSpam") : t("reader.spam")}
          onClick={() => void actions.spam(ids, !inJunk).then(() => selectThread(null))}
        />
        <IconButton
          icon={Star}
          label={flagged ? t("reader.unflag") : t("reader.flag")}
          active={flagged}
          onClick={() => void actions.setFlags(flagged ? ids : [latest.id], { flagged: !flagged })}
        />
        <IconButton
          icon={MailOpen}
          label={t("reader.markUnread")}
          onClick={() => void actions.setFlags([latest.id], { seen: false }).then(() => selectThread(null))}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className={clsx("mx-auto flex max-w-[820px] flex-col gap-3", variant === "pro" ? "p-5" : "p-4")}>
          <h2 className="selectable px-1 pt-1 pb-2 text-[22px] leading-tight font-extrabold tracking-[-0.01em]">
            {data.thread.subject || t("reader.noSubject")}
          </h2>
          {hiddenCount > 1 && (
            <button
              type="button"
              onClick={() => expand(ids)}
              className="self-start rounded-full bg-pink-tint px-3 py-1 text-[12.5px] font-semibold text-pink-ink hover:bg-pink-tint-strong"
            >
              {t("reader.earlier", { count: hiddenCount })}
            </button>
          )}
          {all.map((message) => (
            <MessageView
              key={message.id}
              message={message}
              accounts={accounts}
              collapsed={!expanded.has(message.id)}
              onExpand={() => expand([message.id])}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
