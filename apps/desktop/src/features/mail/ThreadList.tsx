import clsx from "clsx";
import {
  Archive,
  FolderInput,
  MailOpen,
  Menu,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Star,
  Trash,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ListFilter } from "@/backend/types";
import type { SceneName } from "@/components/nyu/scenes";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n";
import { flattenThreads, useAccounts, useMessageActions, useThreadActions, useThreads } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { openDraftThread } from "../compose/openDraft";
import { useSelectionActions } from "./selection";
import { ThreadRow } from "./ThreadRow";
import { useViewInfo } from "./view";

const FILTERS: ListFilter[] = ["all", "unread", "flagged", "attachments"];

const EMPTY_SCENES = {
  noAccount: "noAccount",
  offline: "offline",
  search: "search",
  inbox: "inbox",
  other: "emptyFolder",
} as const satisfies Record<string, SceneName>;

export const SEARCH_INPUT_ID = "uwu-search";

interface ThreadListProps {
  variant: "simple" | "pro";
  className?: string;
}

export function ThreadList({ variant, className }: ThreadListProps) {
  const { t } = useT();
  const view = useUi((s) => s.view);
  const filter = useUi((s) => s.filter);
  const search = useUi((s) => s.search);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const { setFilter, setSearch, selectThread, setVisibleThreadIds, setFolderDrawerOpen, setAddAccountOpen } =
    useUi.getState();
  const info = useViewInfo(view);
  const { data: accounts = [], isSuccess: accountsLoaded } = useAccounts();
  const { refresh } = useMessageActions();
  const threadActions = useThreadActions();
  const density = useSettings((s) => s.listDensity);
  const [refreshing, setRefreshing] = useState(false);
  const checked = useUi((s) => s.checkedThreadIds);
  const setChecked = useUi((s) => s.setCheckedThreadIds);
  const selection = useSelectionActions();
  // Where a Shift+click range starts.
  const anchor = useRef<string | null>(null);

  const [draft, setDraft] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft), 180);
    return () => clearTimeout(timer);
  }, [draft, setSearch]);

  const query = useThreads(view, filter, search);
  const threads = flattenThreads(query.data?.pages);
  const ids = threads.map((thread) => thread.id).join("|");
  useEffect(() => {
    setVisibleThreadIds(ids ? ids.split("|") : []);
  }, [ids, setVisibleThreadIds]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedThreadId) return;
    listRef.current
      ?.querySelector(`[data-thread-id="${CSS.escape(selectedThreadId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedThreadId]);

  const showAccount = accounts.length > 1 && view.kind === "unified";
  const checkedThreads = threads.filter((thread) => checked.includes(thread.id));
  const anyUnread = checkedThreads.some((thread) => thread.unreadCount > 0);
  const allFlagged = checkedThreads.length > 0 && checkedThreads.every((thread) => thread.flagged);
  const runOnChecked = (action: (threadIds: string[]) => Promise<unknown>) => {
    const ids = checked;
    setChecked([]);
    void action(ids);
  };
  const empty =
    accountsLoaded && accounts.length === 0
      ? "noAccount"
      : search
        ? "search"
        : accounts.length > 0 && accounts.every((account) => account.status.state === "offline")
          ? "offline"
          : info.isInbox && filter === "all"
            ? "inbox"
            : "other";

  return (
    <section className={clsx("flex h-full min-w-0 flex-col bg-surface", className)} aria-label={info.title}>
      <header className={clsx("flex flex-col gap-3 pt-4", variant === "pro" ? "px-5 pb-3" : "px-4 pb-2")}>
        <div className="flex items-center gap-2">
          {variant === "simple" && (
            <IconButton icon={Menu} label={t("nav.menu")} onClick={() => setFolderDrawerOpen(true)} className="-ml-1" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[20px] leading-tight font-extrabold tracking-[-0.01em]">{info.title}</h1>
            {info.subtitle && <p className="truncate text-[12px] text-muted">{info.subtitle}</p>}
          </div>
          <IconButton
            icon={RefreshCw}
            label={t("list.refresh")}
            className={clsx(refreshing && "[&>svg]:animate-spin")}
            onClick={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        </div>

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            id={SEARCH_INPUT_ID}
            type="search"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft("");
                event.currentTarget.blur();
              }
            }}
            placeholder={t("list.search")}
            className="h-10 w-full rounded-full border border-transparent bg-canvas pr-10 pl-10 text-[13.5px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {draft && (
            <IconButton
              icon={X}
              size="sm"
              label={t("list.clearSearch")}
              onClick={() => setDraft("")}
              className="absolute top-1/2 right-1 -translate-y-1/2"
            />
          )}
        </div>

        {checked.length > 0 ? (
          <div
            className="flex h-9 items-center gap-0.5 rounded-full bg-pink-tint pr-1 pl-1 text-pink-ink"
            role="toolbar"
            aria-label={t("list.selected", { count: checked.length })}
          >
            <IconButton icon={X} size="sm" label={t("list.clearSelection")} onClick={() => setChecked([])} />
            <span className="min-w-0 flex-1 truncate px-1 text-[13px] font-bold">
              {t("list.selected", { count: checked.length })}
            </span>
            <IconButton
              icon={Archive}
              size="sm"
              label={t("reader.archive")}
              onClick={() => runOnChecked(selection.archive)}
            />
            <IconButton
              icon={Trash}
              size="sm"
              label={t("reader.trash")}
              onClick={() => runOnChecked(selection.trash)}
            />
            <IconButton
              icon={MailOpen}
              size="sm"
              label={anyUnread ? t("list.markRead") : t("reader.markUnread")}
              onClick={() => runOnChecked((ids) => selection.read(ids, anyUnread))}
            />
            <IconButton
              icon={Star}
              size="sm"
              label={t("reader.flag")}
              onClick={() => runOnChecked((ids) => selection.flag(ids, !allFlagged))}
            />
            <IconButton
              icon={FolderInput}
              size="sm"
              label={t("reader.move")}
              onClick={() => runOnChecked(selection.move)}
            />
            <IconButton
              icon={ShieldAlert}
              size="sm"
              label={t("reader.spam")}
              onClick={() => runOnChecked((ids) => selection.spam(ids, true))}
            />
          </div>
        ) : (
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="toolbar" aria-label={t("list.search")}>
            {FILTERS.map((item) => (
              <Pill key={item} active={filter === item} onClick={() => setFilter(item)}>
                {t(`filter.${item}`)}
              </Pill>
            ))}
          </div>
        )}
      </header>

      <div
        ref={listRef}
        className={clsx(
          "flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-4",
          density === "compact" ? "gap-px" : "gap-1",
          variant === "pro" && "border-t border-hairline pt-2",
        )}
      >
        {query.isPending ? (
          <p className="px-6 py-10 text-center text-[13px] text-muted">{t("list.loading")}</p>
        ) : threads.length === 0 ? (
          <EmptyState
            scene={EMPTY_SCENES[empty]}
            compact={variant === "pro"}
            title={t(`list.empty.${empty}.title`)}
            body={t(`list.empty.${empty}.body`)}
            action={
              empty === "noAccount" && (
                <Button variant="primary" icon={Plus} onClick={() => setAddAccountOpen(true)}>
                  {t("nav.addAccount")}
                </Button>
              )
            }
            className="h-full"
          />
        ) : (
          <>
            {threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                variant={variant}
                density={density}
                selected={thread.id === selectedThreadId}
                accounts={accounts}
                showAccount={showAccount}
                actions={threadActions}
                checked={checked.includes(thread.id)}
                dragIds={checked.includes(thread.id) ? checked : [thread.id]}
                onSelect={(event) => {
                  if (event.ctrlKey || event.metaKey) {
                    anchor.current = thread.id;
                    setChecked(
                      checked.includes(thread.id) ? checked.filter((id) => id !== thread.id) : [...checked, thread.id],
                    );
                  } else if (event.shiftKey && anchor.current) {
                    const order = threads.map((item) => item.id);
                    const start = order.indexOf(anchor.current);
                    const end = order.indexOf(thread.id);
                    if (start >= 0) {
                      const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
                      setChecked([...new Set([...checked, ...range])]);
                    }
                  } else if (info.isDrafts) {
                    void openDraftThread(thread.id);
                  } else {
                    anchor.current = thread.id;
                    selectThread(thread.id);
                  }
                }}
              />
            ))}
            {query.hasNextPage && (
              <div className="flex justify-center p-4">
                <Button size="sm" busy={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  {t("list.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
