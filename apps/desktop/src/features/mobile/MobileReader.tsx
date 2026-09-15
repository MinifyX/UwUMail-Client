import clsx from "clsx";
import {
  Archive,
  ArrowLeft,
  EllipsisVertical,
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
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n";
import { useAccounts, useFolders, useMessageActions, useThread } from "@/lib/queries";
import { useUi } from "@/state/ui";
import { MessageView } from "../mail/MessageView";
import { requestMove } from "../mail/selection";

/** Messages that start expanded: the newest one plus every unread one. */
function initiallyExpanded(messages: Message[]) {
  const ids = new Set(messages.filter((m) => !m.flags.seen).map((m) => m.id));
  const last = messages[messages.length - 1];
  if (last) ids.add(last.id);
  return ids;
}

function BarButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 text-muted active:bg-pink-tint active:text-pink-ink"
    >
      <Icon className="size-[22px]" strokeWidth={2} aria-hidden />
      <span className="max-w-full truncate text-[11px] font-semibold">{label}</span>
    </button>
  );
}

/** A conversation on the phone: back and subject on top, the actions at thumb height. */
export function MobileReader({ threadId }: { threadId: string }) {
  const { t } = useT();
  const selectThread = useUi((s) => s.selectThread);
  const openCompose = useUi((s) => s.openCompose);
  const { data, isPending, isError, refetch, isRefetching } = useThread(threadId);
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const actions = useMessageActions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  const lastScroll = useRef(0);
  const messages = data?.messages;
  const loadedThreadId = data?.thread.id;

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

  const back = () => selectThread(null);

  if (isError && !data) {
    return (
      <section className="flex h-full flex-col bg-canvas">
        <header className="flex h-14 items-center px-2">
          <IconButton icon={ArrowLeft} label={t("reader.back")} onClick={back} />
        </header>
        <EmptyState
          scene="loadError"
          title={t("reader.error.title")}
          body={t("reader.error.body")}
          action={
            <Button icon={RefreshCw} busy={isRefetching} onClick={() => void refetch()}>
              {t("reader.error.retry")}
            </Button>
          }
          className="flex-1"
        />
      </section>
    );
  }

  if (isPending || !data) {
    return (
      <section className="flex h-full flex-col bg-canvas">
        <header className="flex h-14 items-center px-2">
          <IconButton icon={ArrowLeft} label={t("reader.back")} onClick={back} />
        </header>
        <p className="flex flex-1 items-center justify-center text-[13px] text-muted">{t("reader.loading")}</p>
      </section>
    );
  }

  const all = data.messages;
  const latest = all[all.length - 1]!;
  const ids = all.map((m) => m.id);
  const flagged = data.thread.flagged;
  const hiddenCount = all.filter((m) => !expanded.has(m.id)).length;
  const leaveAfter = (work: Promise<void>) => void work.then(back);
  const inJunk = all.every((m) => folders.find((f) => f.id === m.folderId)?.role === "junk");

  return (
    <section className="flex h-full min-w-0 flex-col bg-canvas" aria-label={data.thread.subject}>
      <header className="relative flex h-14 shrink-0 items-center gap-1 border-b border-hairline bg-surface px-1.5">
        <IconButton icon={ArrowLeft} label={t("reader.back")} onClick={back} />
        <h1 className="min-w-0 flex-1 truncate px-1 text-[16px] font-bold">
          {data.thread.subject || t("reader.noSubject")}
        </h1>
        <IconButton
          icon={Star}
          label={flagged ? t("reader.unflag") : t("reader.flag")}
          active={flagged}
          onClick={() => void actions.setFlags(flagged ? ids : [latest.id], { flagged: !flagged })}
        />
        <IconButton
          icon={EllipsisVertical}
          label={t("mobile.more")}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        />
        {menuOpen && (
          <>
            <button
              type="button"
              aria-label={t("common.close")}
              className="fixed inset-0 z-20 cursor-default"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute top-12 right-2 z-30 min-w-[220px] animate-pop overflow-hidden rounded-2xl border border-hairline bg-elevated py-1 shadow-float">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  requestMove(all, back);
                }}
                className="flex h-12 w-full items-center gap-3 px-4 text-left text-[14px] font-medium active:bg-pink-tint"
              >
                <FolderInput className="size-[18px] text-muted" aria-hidden />
                {t("reader.move")}
              </button>
              <button
                type="button"
                onClick={() => leaveAfter(actions.spam(ids, !inJunk))}
                className="flex h-12 w-full items-center gap-3 px-4 text-left text-[14px] font-medium active:bg-pink-tint"
              >
                {inJunk ? (
                  <ShieldCheck className="size-[18px] text-muted" aria-hidden />
                ) : (
                  <ShieldAlert className="size-[18px] text-muted" aria-hidden />
                )}
                {inJunk ? t("reader.notSpam") : t("reader.spam")}
              </button>
              <button
                type="button"
                onClick={() => leaveAfter(actions.setFlags([latest.id], { seen: false }))}
                className="flex h-12 w-full items-center gap-3 px-4 text-left text-[14px] font-medium active:bg-pink-tint"
              >
                <MailOpen className="size-[18px] text-muted" aria-hidden />
                {t("reader.markUnread")}
              </button>
            </div>
          </>
        )}
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop;
          const atBottom = top + event.currentTarget.clientHeight >= event.currentTarget.scrollHeight - 8;
          if (Math.abs(top - lastScroll.current) > 8) setBarHidden(top > lastScroll.current && top > 40 && !atBottom);
          lastScroll.current = top;
        }}
      >
        <div className="flex flex-col gap-2.5 px-2.5 pt-3 pb-24">
          <h2 className="selectable px-1.5 pb-1 text-[20px] leading-tight font-extrabold tracking-[-0.01em]">
            {data.thread.subject || t("reader.noSubject")}
          </h2>
          {hiddenCount > 1 && (
            <button
              type="button"
              onClick={() => expand(ids)}
              className="self-start rounded-full bg-pink-tint px-3 py-1.5 text-[13px] font-semibold text-pink-ink"
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

      <nav
        className={clsx(
          "fixed inset-x-0 bottom-0 z-10 flex border-t border-hairline bg-surface/95 px-1 pt-1 pb-1.5 backdrop-blur transition-transform duration-200",
          barHidden && "translate-y-full",
        )}
        aria-label={t("mobile.actions")}
      >
        <BarButton
          icon={Reply}
          label={t("reader.reply")}
          onClick={() => openCompose({ mode: "reply", source: latest })}
        />
        <BarButton
          icon={ReplyAll}
          label={t("mobile.replyAllShort")}
          onClick={() => openCompose({ mode: "replyAll", source: latest })}
        />
        <BarButton
          icon={Forward}
          label={t("reader.forward")}
          onClick={() => openCompose({ mode: "forward", source: latest })}
        />
        <BarButton icon={Archive} label={t("mobile.swipe.archive")} onClick={() => leaveAfter(actions.archive(ids))} />
        <BarButton icon={Trash} label={t("reader.trash")} onClick={() => leaveAfter(actions.trash(ids))} />
      </nav>
    </section>
  );
}
