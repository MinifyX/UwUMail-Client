import clsx from "clsx";
import { Archive, Check, MailCheck, Menu, PenLine, Plus, RefreshCw, Search, Star, Trash, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ListFilter } from "@/backend/types";
import type { SceneName } from "@/components/nyu/scenes";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n";
import { useBackLayer } from "@/lib/backStack";
import { flattenThreads, useAccounts, useMessageActions, useThreads } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { useUi } from "@/state/ui";
import { ThreadRow } from "../mail/ThreadRow";
import { useViewInfo } from "../mail/view";
import { PullToRefresh } from "./PullToRefresh";
import { SwipeRow } from "./SwipeRow";
import { useThreadActions } from "./threadActions";

const FILTERS: ListFilter[] = ["all", "unread", "flagged", "attachments"];

const EMPTY_SCENES = {
  noAccount: "noAccount",
  offline: "offline",
  search: "search",
  inbox: "inbox",
  other: "emptyFolder",
} as const satisfies Record<string, SceneName>;

/** The phone's first screen: one column of mail with search, filters, swipes and Nyu's pull to refresh. */
export function MobileList() {
  const { t } = useT();
  const view = useUi((s) => s.view);
  const filter = useUi((s) => s.filter);
  const search = useUi((s) => s.search);
  const reading = useUi((s) => s.selectedThreadId !== null);
  const {
    setFilter,
    setSearch,
    selectThread,
    setVisibleThreadIds,
    setFolderDrawerOpen,
    setAddAccountOpen,
    openCompose,
  } = useUi.getState();
  const layout = useSettings((s) => s.layout);
  const swipeRight = useSettings((s) => s.swipeRight);
  const swipeLeft = useSettings((s) => s.swipeLeft);
  const info = useViewInfo(view);
  const { data: accounts = [], isSuccess: accountsLoaded } = useAccounts();
  const { refresh } = useMessageActions();
  const threadActions = useThreadActions();
  const [draftSearch, setDraftSearch] = useState(search);
  // A selection belongs to one folder, filter and search; switching ends it.
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>({ key: "", ids: new Set() });
  const [compact, setCompact] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draftSearch), 180);
    return () => clearTimeout(timer);
  }, [draftSearch, setSearch]);

  const query = useThreads(view, filter, search);
  const threads = flattenThreads(query.data?.pages);
  const ids = threads.map((thread) => thread.id).join("|");
  useEffect(() => {
    setVisibleThreadIds(ids ? ids.split("|") : []);
  }, [ids, setVisibleThreadIds]);

  const selectionKey = JSON.stringify([view, filter, search]);
  const selected = selection.key === selectionKey ? selection.ids : new Set<string>();
  const setSelected = (ids: Set<string>) => setSelection({ key: selectionKey, ids });

  const selecting = selected.size > 0;
  useBackLayer(selecting, () => setSelected(new Set()));

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const showAccount = accounts.length > 1 && view.kind === "unified";
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

  const chosen = threads.filter((thread) => selected.has(thread.id));
  const runOnSelection = (action: "read" | "archive" | "trash" | "flag") => {
    void threadActions.run(action, chosen);
    setSelected(new Set());
  };

  return (
    <section className="flex h-full min-w-0 flex-col bg-surface" aria-label={info.title}>
      <header className="flex flex-col gap-2.5 px-3 pt-2 pb-2">
        {selecting ? (
          <div className="flex h-12 items-center gap-1 rounded-2xl bg-pink-tint px-1 text-pink-ink">
            <IconButton icon={X} label={t("mobile.selection.clear")} onClick={() => setSelected(new Set())} />
            <p className="min-w-0 flex-1 truncate text-[15px] font-bold">
              {t("mobile.selected", { count: selected.size })}
            </p>
            <IconButton icon={MailCheck} label={t("mobile.swipe.read")} onClick={() => runOnSelection("read")} />
            <IconButton icon={Star} label={t("reader.flag")} onClick={() => runOnSelection("flag")} />
            <IconButton icon={Archive} label={t("reader.archive")} onClick={() => runOnSelection("archive")} />
            <IconButton icon={Trash} label={t("reader.trash")} onClick={() => runOnSelection("trash")} />
          </div>
        ) : (
          <div className="flex h-12 items-center gap-1">
            <IconButton icon={Menu} label={t("nav.menu")} onClick={() => setFolderDrawerOpen(true)} />
            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-[20px] leading-tight font-extrabold tracking-[-0.01em]">{info.title}</h1>
              {info.subtitle && <p className="truncate text-[12px] text-muted">{info.subtitle}</p>}
            </div>
            <IconButton
              icon={RefreshCw}
              label={t("list.refresh")}
              className={clsx(query.isFetching && "[&>svg]:animate-spin")}
              onClick={() => void refresh()}
            />
          </div>
        )}

        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            type="search"
            value={draftSearch}
            onChange={(event) => setDraftSearch(event.target.value)}
            placeholder={t("list.search")}
            enterKeyHint="search"
            className="h-11 w-full rounded-full border border-transparent bg-canvas pr-11 pl-10 text-[15px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {draftSearch && (
            <IconButton
              icon={X}
              label={t("list.clearSearch")}
              onClick={() => setDraftSearch("")}
              className="absolute top-1/2 right-1 -translate-y-1/2"
            />
          )}
        </div>

        <div className="-mx-3 flex [scrollbar-width:none] gap-2 overflow-x-auto px-3 pb-0.5" role="toolbar">
          {FILTERS.map((item) => (
            <Pill key={item} active={filter === item} onClick={() => setFilter(item)}>
              {t(`filter.${item}`)}
            </Pill>
          ))}
        </div>
      </header>

      <PullToRefresh scrollRef={scroller} onRefresh={refresh}>
        <div
          ref={scroller}
          onScroll={(event) => {
            const top = event.currentTarget.scrollTop;
            // The write button shrinks while scrolling down and grows again going up.
            if (Math.abs(top - lastScroll.current) > 6) setCompact(top > lastScroll.current && top > 24);
            lastScroll.current = top;
            if (
              query.hasNextPage &&
              !query.isFetchingNextPage &&
              top + event.currentTarget.clientHeight > event.currentTarget.scrollHeight - 600
            ) {
              void query.fetchNextPage();
            }
          }}
          className="h-full overflow-y-auto overscroll-contain pb-28"
        >
          {query.isPending ? (
            <p className="px-6 py-10 text-center text-[13px] text-muted">{t("list.loading")}</p>
          ) : threads.length === 0 ? (
            <EmptyState
              scene={EMPTY_SCENES[empty]}
              title={t(`list.empty.${empty}.title`)}
              body={t(`list.empty.${empty}.body`)}
              action={
                empty === "noAccount" && (
                  <Button variant="primary" icon={Plus} onClick={() => setAddAccountOpen(true)}>
                    {t("nav.addAccount")}
                  </Button>
                )
              }
              className="min-h-full"
            />
          ) : (
            <ul className={clsx(layout === "simple" && "px-1")}>
              {threads.map((thread) => {
                const isSelected = selected.has(thread.id);
                return (
                  <li key={thread.id} className={clsx(layout === "simple" && "py-0.5")}>
                    <SwipeRow
                      right={swipeRight}
                      left={swipeLeft}
                      unread={thread.unreadCount > 0}
                      selecting={selecting}
                      onSwipe={(action) => void threadActions.run(action, [thread])}
                      onLongPress={() => toggle(thread.id)}
                    >
                      <div className="relative">
                        <ThreadRow
                          thread={thread}
                          variant={layout}
                          selected={isSelected}
                          accounts={accounts}
                          showAccount={showAccount}
                          onSelect={() => (selecting ? toggle(thread.id) : selectThread(thread.id))}
                        />
                        {isSelected && layout === "simple" && (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute top-3 left-3 grid size-10 animate-pop place-items-center rounded-full bg-pink-solid text-on-pink"
                          >
                            <Check className="size-5" strokeWidth={3} />
                          </span>
                        )}
                      </div>
                    </SwipeRow>
                  </li>
                );
              })}
              {query.isFetchingNextPage && (
                <li className="py-4 text-center text-[12.5px] text-muted">{t("list.loading")}</li>
              )}
            </ul>
          )}
        </div>
      </PullToRefresh>

      {!selecting && !reading && accounts.length > 0 && (
        <button
          type="button"
          onClick={() => openCompose({ mode: "new" })}
          aria-label={t("nav.compose")}
          className={clsx(
            "fixed right-4 bottom-4 z-20 flex h-14 items-center justify-center gap-2 rounded-2xl bg-pink-solid font-bold text-on-pink shadow-[0_6px_20px_rgb(225_29_116/0.35)] transition-[width,padding] duration-200 active:scale-95",
            compact ? "w-14" : "px-5",
          )}
        >
          <PenLine className="size-5 shrink-0" strokeWidth={2.4} aria-hidden />
          {!compact && <span className="text-[15px]">{t("nav.compose")}</span>}
        </button>
      )}
    </section>
  );
}
