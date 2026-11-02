import clsx from "clsx";
import {
  Button,
  EmptyState,
  Fab,
  Icon,
  IconButton,
  ICONS,
  NavButton,
  Pill,
  Screen,
  type MobilePlatform,
} from "@uwusuite/design";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTauri } from "@/backend/backend";
import { searchServer } from "@/backend/mobile";
import type { ListFilter, ThreadSummary } from "@/backend/types";
import type { SceneName } from "@/components/nyu/scenes";
import { NyuScene } from "@/components/nyu/scenes";
import { useT } from "@/i18n";
import { useBackLayer } from "@/lib/backStack";
import {
  flattenThreads,
  useAccounts,
  useFolders,
  useMessageActions,
  useThreadActions as useCardActions,
  useThreads,
  useListScope,
  useVisibleAccounts,
} from "@/lib/queries";
import { canEmpty, useFolderEdit } from "@/state/folderEdit";
import { useLayout, useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { ThreadRow } from "../mail/ThreadRow";
import { useViewInfo } from "../mail/view";
import { openDraftThread } from "../compose/openDraft";
import { useSelectionActions } from "../mail/selection";
import { useSnoozedRows } from "../mail/snooze";
import { useWorkspaceName } from "../workspaces/workspaces";
import { VerificationCodeBar } from "../verification/VerificationCodeBar";
import { useVerificationCodes } from "../verification/useVerificationCodes";
import { codeFor } from "../verification/format";
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

/**
 * A mailbox on a phone, pushed over the mailbox overview: one column of mail with filters, swipes
 * and pull to refresh. The search sits in the shell (iPhone: beside the tab bar) or comes in as
 * `searchBar` (Android: at the top, instead of the app bar).
 */
export function MobileList({
  platform,
  onBack,
  leading,
  searchBar,
}: {
  platform: MobilePlatform;
  onBack: () => void;
  leading?: ReactNode;
  searchBar?: ReactNode;
}) {
  const { t } = useT();
  const view = useUi((s) => s.view);
  const filter = useUi((s) => s.filter);
  const search = useUi((s) => s.search);
  const reading = useUi((s) => s.selectedThreadId !== null);
  const { setFilter, selectThread, setVisibleThreadIds, setAddAccountOpen, openCompose, openSettings } =
    useUi.getState();
  const layout = useLayout();
  const density = useSettings((s) => s.listDensity);
  const swipeRight = useSettings((s) => s.swipeRight);
  const swipeLeft = useSettings((s) => s.swipeLeft);
  const activeWorkspace = useSettings((s) => s.activeWorkspace);
  const workspaceName = useWorkspaceName();
  const info = useViewInfo(view);
  const snoozedRows = useSnoozedRows(view);
  const { data: accounts = [] } = useAccounts();
  const { data: folders = [] } = useFolders();
  const emptiable = view.kind === "folder" ? folders.find((f) => f.id === view.folderId && canEmpty(f)) : undefined;
  const { accounts: shown, loaded: accountsLoaded } = useVisibleAccounts();
  const { accountIds, includeFolderIds } = useListScope(view);
  const { refresh } = useMessageActions();
  const threadActions = useThreadActions();
  const selectionActions = useSelectionActions();
  // The card's own quick actions only show on hover, so they stay out of the way on touch.
  const cardActions = useCardActions();
  // A selection belongs to one folder, filter, search and workspace; switching ends it.
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>({ key: "", ids: new Set() });
  // Results from the server search, for the folder, filter and search they were made for.
  const [server, setServer] = useState<{ key: string; threads: ThreadSummary[] } | null>(null);
  const [searchingServer, setSearchingServer] = useState(false);
  const conversations = useSettings((s) => s.conversations);
  const codes = useVerificationCodes();
  const end = useRef<HTMLLIElement>(null);

  const query = useThreads(view, filter, search);
  // The next page loads as the end of the list comes near.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const node = end.current;
    if (!node || !hasNextPage || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (seen) => {
        if (seen.some((each) => each.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  const local = flattenThreads(query.data?.pages);
  const searchKey = JSON.stringify([view, filter, search, conversations, accountIds, includeFolderIds]);
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
        includeFolderIds,
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
    <Button icon={ICONS.server} busy={searchingServer} onClick={() => void askServer()}>
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

  const trailing = (
    <>
      {emptiable && (
        <NavButton
          icon={ICONS.delete}
          label={emptiable.role === "junk" ? t("folders.emptyJunk") : t("folders.emptyTrash")}
          disabled={emptiable.total === 0}
          platform={platform}
          onClick={() => useFolderEdit.getState().open({ kind: "empty", folder: emptiable })}
        />
      )}
      {/* iPhone: writing starts top right; Android has the FAB. */}
      {platform !== "android" && accounts.length > 0 && (
        <NavButton
          icon={ICONS.compose}
          label={t("nav.compose")}
          platform={platform}
          onClick={() => openCompose({ mode: "new" })}
        />
      )}
    </>
  );

  return (
    <Screen
      title={info.title}
      subtitle={info.subtitle}
      largeTitle
      leading={leading}
      trailing={trailing}
      onBack={onBack}
      onRefresh={refresh}
      searchBar={selecting ? undefined : searchBar}
      platform={platform}
      className="uwu-push-in"
    >
      <div className="sticky top-0 z-10 flex flex-col gap-2.5 bg-[inherit] px-3 pb-2">
        {selecting && (
          <div className="flex h-12 items-center gap-1 rounded-2xl bg-pink-tint px-1 text-pink-ink">
            <IconButton icon={ICONS.close} label={t("mobile.selection.clear")} onClick={() => setSelected(new Set())} />
            <p className="min-w-0 flex-1 truncate text-[15px] font-bold">
              {t("mobile.selected", { count: selected.size })}
            </p>
            <IconButton icon={ICONS.unread} label={t("mobile.swipe.read")} onClick={() => runOnSelection("read")} />
            <IconButton icon={ICONS.favorite} label={t("reader.flag")} onClick={() => runOnSelection("flag")} />
            <IconButton icon={ICONS.archive} label={t("reader.archive")} onClick={() => runOnSelection("archive")} />
            <IconButton
              icon={ICONS.delete}
              label={info.isTrash ? t("reader.deleteForever") : t("reader.trash")}
              onClick={() => runOnSelection("trash")}
            />
            <IconButton icon={ICONS.move} label={t("reader.move")} onClick={moveSelection} />
          </div>
        )}

        <div className="-mx-3 flex [scrollbar-width:none] gap-2 overflow-x-auto px-3 pb-0.5" role="toolbar">
          {FILTERS.map((item) => (
            <Pill key={item} active={filter === item} onClick={() => setFilter(item)}>
              {t(`filter.${item}`)}
            </Pill>
          ))}
        </div>
        <VerificationCodeBar codes={codes} className="-mx-3 px-3" />
      </div>

      <div className="pb-32">
        {query.isPending ? (
          <p className="px-6 py-10 text-center text-[13px] text-muted">{t("list.loading")}</p>
        ) : threads.length === 0 ? (
          <EmptyState
            art={<NyuScene name={EMPTY_SCENES[empty]} />}
            title={t(`list.empty.${empty}.title`, { name: workspaceName(activeWorkspace) })}
            body={t(`list.empty.${empty}.body`)}
            action={
              empty === "noAccount" ? (
                <Button variant="primary" icon={ICONS.add} onClick={() => setAddAccountOpen(true)}>
                  {t("nav.addAccount")}
                </Button>
              ) : empty === "workspace" ? (
                <Button variant="primary" icon={ICONS.account} onClick={() => openSettings("accounts")}>
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
                        snoozedUntil={snoozedRows?.get(thread.id)}
                        code={codeFor(codes, thread.id)}
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
                          <Icon icon={ICONS.done} size={density === "compact" ? "sm" : "lg"} />
                        </span>
                      )}
                    </div>
                  </SwipeRow>
                </li>
              );
            })}
            <li ref={end} aria-hidden />
            {query.isFetchingNextPage && (
              <li className="py-4 text-center text-[12.5px] text-muted">{t("list.loading")}</li>
            )}
            {serverButton && !query.hasNextPage && <li className="flex justify-center px-4 py-5">{serverButton}</li>}
          </ul>
        )}
      </div>

      {platform === "android" && !selecting && !reading && accounts.length > 0 && (
        <Fab
          extended
          icon={ICONS.compose}
          label={t("nav.compose")}
          className="fixed right-4 bottom-[calc(var(--uwu-safe-bottom,0px)+96px)] z-20"
          onClick={() => openCompose({ mode: "new" })}
        />
      )}
    </Screen>
  );
}
