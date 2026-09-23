import clsx from "clsx";
import {
  Archive,
  Check,
  CloudDownload,
  FolderInput,
  MailCheck,
  Menu,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTauri } from "@/backend/backend";
import { searchServer } from "@/backend/mobile";
import type { ListFilter, ThreadSummary } from "@/backend/types";
import type { SceneName } from "@/components/nyu/scenes";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import { useT } from "@/i18n";
import { useBackLayer } from "@/lib/backStack";
import {
  flattenThreads,
  useAccounts,
  useFolders,
  useMessageActions,
  useThreadActions as useCardActions,
  useThreads,
  useVisibleAccounts,
} from "@/lib/queries";
import { canEmpty, useFolderEdit } from "@/state/folderEdit";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { ThreadRow } from "../mail/ThreadRow";
import { useViewInfo } from "../mail/view";
import { openDraftThread } from "../compose/openDraft";
import { useSelectionActions } from "../mail/selection";
import { WorkspaceSwitch } from "../workspaces/WorkspaceSwitch";
import { useWorkspaceName } from "../workspaces/workspaces";
import { PullToRefresh } from "./PullToRefresh";
import { SwipeRow } from "./SwipeRow";
import { useThreadActions } from "./threadActions";

const FILTERS: ListFilter[] = ["all", "unread", "flagged", "attachments"];

const EMPTY_SCENES = {
  noAccount: "noAccount",
  workspace: "noAccount",
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
    openSettings,
  } = useUi.getState();
  const layout = useSettings((s) => s.layout);
  const density = useSettings((s) => s.listDensity);
  const swipeRight = useSettings((s) => s.swipeRight);
  const swipeLeft = useSettings((s) => s.swipeLeft);
  const activeWorkspace = useSettings((s) => s.activeWorkspace);
  const workspaceName = useWorkspaceName();
  const info = useViewInfo(view);
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const emptiable = view.kind === "folder" ? folders.find((f) => f.id === view.folderId && canEmpty(f)) : undefined;
  const { accounts: shown, loaded: accountsLoaded, accountIds } = useVisibleAccounts();
  const { refresh } = useMessageActions();
  const threadActions = useThreadActions();
  const selectionActions = useSelectionActions();
  // The card's own quick actions only show on hover, so they stay out of the way on touch.
  const cardActions = useCardActions();
  const [draftSearch, setDraftSearch] = useState(search);
  // A selection belongs to one folder, filter, search and workspace; switching ends it.
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>({ key: "", ids: new Set() });
  const [compact, setCompact] = useState(false);
  // Results from the server search, for the folder, filter and search they were made for.
  const [server, setServer] = useState<{ key: string; threads: ThreadSummary[] } | null>(null);
  const [searchingServer, setSearchingServer] = useState(false);
  const conversations = useSettings((s) => s.conversations);
  const scroller = useRef<HTMLDivElement>(null);
  const lastScroll = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draftSearch), 180);
    return () => clearTimeout(timer);
  }, [draftSearch, setSearch]);

  const query = useThreads(view, filter, search);
  const local = flattenThreads(query.data?.pages);
  const searchKey = JSON.stringify([view, filter, search, conversations, accountIds]);
  const fromServer = server?.key === searchKey ? server.threads : null;
  // Server matches join the local ones in the same list, newest first.
  const threads = fromServer
    ? [...new Map([...local, ...fromServer].map((thread) => [thread.id, thread])).values()].sort((a, b) =>
        b.lastDate.localeCompare(a.lastDate),
      )
    : local;

  const askServer = async () => {
    setSearchingServer(true);
    try {
      const page = await searchServer({
        view,
        filter,
        search,
        conversations,
        accountIds: accountIds ?? undefined,
        limit: 200,
      });
      if (page) {
        setServer({ key: searchKey, threads: page.threads });
        if (page.threads.every((thread) => local.some((known) => known.id === thread.id))) {
          toast(t("mobile.serverSearch.nothingMore"), "info");
        }
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      toast(t("mobile.serverSearch.failed", { reason: message }), "error");
    } finally {
      setSearchingServer(false);
    }
  };
  const serverButton = search && isTauri() && !fromServer && (
    <Button icon={CloudDownload} busy={searchingServer} onClick={() => void askServer()}>
      {searchingServer ? t("mobile.serverSearch.searching") : t("mobile.serverSearch.button")}
    </Button>
  );
  const ids = threads.map((thread) => thread.id).join("|");
  useEffect(() => {
    setVisibleThreadIds(ids ? ids.split("|") : []);
  }, [ids, setVisibleThreadIds]);

  const selectionKey = JSON.stringify([view, filter, search, accountIds]);
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

  const showAccount = shown.length > 1 && view.kind === "unified";
  const empty =
    accountsLoaded && accounts.length === 0
      ? "noAccount"
      : accountsLoaded && shown.length === 0
        ? "workspace"
        : search
          ? "search"
          : shown.length > 0 && shown.every((account) => account.status.state === "offline")
            ? "offline"
            : info.isInbox && filter === "all"
              ? "inbox"
              : "other";

  const chosen = threads.filter((thread) => selected.has(thread.id));
  const runOnSelection = (action: "read" | "archive" | "trash" | "flag") => {
    void threadActions.run(action, chosen);
    setSelected(new Set());
  };
  const moveSelection = () => {
    void selectionActions.move(chosen.map((thread) => thread.id));
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
            <IconButton
              icon={Trash}
              label={info.isTrash ? t("reader.deleteForever") : t("reader.trash")}
              onClick={() => runOnSelection("trash")}
            />
            <IconButton icon={FolderInput} label={t("reader.move")} onClick={moveSelection} />
          </div>
        ) : (
          <div className="flex h-12 items-center gap-1">
            <IconButton icon={Menu} label={t("nav.menu")} onClick={() => setFolderDrawerOpen(true)} />
            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-[20px] leading-tight font-extrabold tracking-[-0.01em]">{info.title}</h1>
              {info.subtitle && <p className="truncate text-[12px] text-muted">{info.subtitle}</p>}
            </div>
            {emptiable && (
              <IconButton
                icon={Trash2}
                label={emptiable.role === "junk" ? t("folders.emptyJunk") : t("folders.emptyTrash")}
                disabled={emptiable.total === 0}
                onClick={() => useFolderEdit.getState().open({ kind: "empty", folder: emptiable })}
              />
            )}
            <IconButton
              icon={RefreshCw}
              label={t("list.refresh")}
              className={clsx(query.isFetching && "[&>svg]:animate-spin")}
              onClick={() => void refresh()}
            />
          </div>
        )}

        <WorkspaceSwitch size="lg" />

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
              title={t(`list.empty.${empty}.title`, { name: workspaceName(activeWorkspace) })}
              body={t(`list.empty.${empty}.body`)}
              action={
                empty === "noAccount" ? (
                  <Button variant="primary" icon={Plus} onClick={() => setAddAccountOpen(true)}>
                    {t("nav.addAccount")}
                  </Button>
                ) : empty === "workspace" ? (
                  <Button variant="primary" icon={Users} onClick={() => openSettings("accounts")}>
                    {t("workspace.assign")}
                  </Button>
                ) : (
                  serverButton
                )
              }
              className="min-h-full"
            />
          ) : (
            <ul className={clsx("flex flex-col px-2", density === "compact" ? "gap-px" : "gap-1")}>
              {threads.map((thread) => {
                const isSelected = selected.has(thread.id);
                return (
                  <li key={thread.id}>
                    <SwipeRow
                      right={swipeRight}
                      left={swipeLeft}
                      unread={thread.unreadCount > 0}
                      selecting={selecting}
                      inJunk={info.isJunk}
                      onSwipe={(action) => void threadActions.run(action, [thread], info.isJunk)}
                      onLongPress={() => toggle(thread.id)}
                    >
                      <div className="relative">
                        <ThreadRow
                          thread={thread}
                          variant={layout}
                          density={density}
                          selected={isSelected}
                          accounts={accounts}
                          showAccount={showAccount}
                          actions={cardActions}
                          inTrash={info.isTrash}
                          inJunk={info.isJunk}
                          onSelect={() =>
                            selecting
                              ? toggle(thread.id)
                              : info.isDrafts
                                ? void openDraftThread(thread.id)
                                : selectThread(thread.id)
                          }
                        />
                        {isSelected && (
                          // Covers the sender picture, wherever the card's density puts it.
                          <span
                            aria-hidden
                            className={clsx(
                              "pointer-events-none absolute grid animate-pop place-items-center rounded-full bg-pink-solid text-on-pink",
                              density === "compact"
                                ? "top-2 left-6 size-7"
                                : clsx("top-3 left-[26px]", layout === "pro" ? "size-9" : "size-10"),
                            )}
                          >
                            <Check className={density === "compact" ? "size-4" : "size-5"} strokeWidth={3} />
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
              {serverButton && !query.hasNextPage && <li className="flex justify-center px-4 py-5">{serverButton}</li>}
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
