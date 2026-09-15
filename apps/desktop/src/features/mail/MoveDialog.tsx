import clsx from "clsx";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { Folder } from "@/backend/types";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { useFolders, useMessageActions } from "@/lib/queries";
import { useUi, type MoveRequest } from "@/state/ui";
import { buildFolderTree, type FolderNode } from "./folderTree";
import { folderIcon } from "./view";

function flatten(nodes: FolderNode[]): FolderNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

export function MoveDialog() {
  const { t } = useT();
  const request = useUi((s) => s.moving);
  const close = useUi((s) => s.closeMove);
  return (
    <Dialog open={request !== null} onClose={close} title={t("move.title")} width="sm">
      {request && <MoveChoices key={request.messageIds.join("|")} request={request} onDone={close} />}
    </Dialog>
  );
}

function MoveChoices({ request, onDone }: { request: MoveRequest; onDone: () => void }) {
  const { t } = useT();
  const { data: folders = [] } = useFolders();
  const actions = useMessageActions();
  const [search, setSearch] = useState("");
  const accountId = request.accountIds.length === 1 ? request.accountIds[0] : null;

  const label = (folder: Folder) => (folder.role ? t(`folder.${folder.role}`) : folder.name);
  const nodes = useMemo(
    () => (accountId ? flatten(buildFolderTree(folders.filter((folder) => folder.accountId === accountId))) : []),
    [folders, accountId],
  );
  const query = search.trim().toLowerCase();
  const shown = nodes.filter(
    (node) =>
      node.folder.selectable &&
      (!query || label(node.folder).toLowerCase().includes(query) || node.folder.path.toLowerCase().includes(query)),
  );

  if (!accountId) {
    return <p className="px-6 pt-1 pb-6 text-[13.5px] text-muted">{t("move.mixedAccounts")}</p>;
  }

  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && shown.length > 0) {
              event.preventDefault();
              pick(shown[0]!.folder);
            }
          }}
          placeholder={t("move.search")}
          aria-label={t("move.search")}
          className="h-10 w-full rounded-full border border-transparent bg-canvas pr-4 pl-10 text-[13.5px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <ul className="flex max-h-[min(420px,60vh)] flex-col gap-0.5 overflow-y-auto">
        {shown.length === 0 ? (
          <li className="px-3 py-6 text-center text-[13px] text-muted">{t("move.empty")}</li>
        ) : (
          shown.map((node) => {
            const Icon = folderIcon(node.folder);
            return (
              <li key={node.folder.id}>
                <button
                  type="button"
                  onClick={() => pick(node.folder)}
                  className={clsx(
                    "flex h-10 w-full items-center gap-2.5 rounded-xl pr-3 text-left text-[13.5px] hover:bg-pink-tint/60 focus-visible:bg-pink-tint/60 focus-visible:outline-none",
                  )}
                  style={{ paddingLeft: 12 + (query ? 0 : node.depth * 16) }}
                >
                  <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{label(node.folder)}</span>
                </button>
              </li>
            );
          })
        )}
      </ul>
    </div>
  );

  function pick(folder: Folder) {
    onDone();
    void actions.move(request.messageIds, { id: folder.id, name: label(folder) }).then(() => request.onMoved?.());
  }
}
