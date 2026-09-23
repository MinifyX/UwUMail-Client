import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { backend } from "@/backend/backend";
import type { Folder } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { useFolderEdit, type FolderRequest } from "@/state/folderEdit";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useRefreshMail() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.folders }),
      client.invalidateQueries({ queryKey: queryKeys.threads }),
      client.invalidateQueries({ queryKey: queryKeys.thread }),
    ]);
}

/** New folder, rename, delete and "empty trash", for whichever folder asked. Mount once. */
export function FolderDialogs() {
  const request = useFolderEdit((s) => s.request);
  const close = useFolderEdit((s) => s.close);
  const naming = request?.kind === "create" || request?.kind === "rename";
  return (
    <>
      <Dialog open={naming} onClose={close} width="sm" title={request && <NameTitle request={request} />}>
        {(request?.kind === "create" || request?.kind === "rename") && (
          <NameForm key={requestKey(request)} request={request} onDone={close} />
        )}
      </Dialog>
      <Dialog open={request?.kind === "delete" || request?.kind === "empty"} onClose={close} width="sm">
        {request?.kind === "delete" && <DeleteQuestion folder={request.folder} onDone={close} />}
        {request?.kind === "empty" && <EmptyQuestion folder={request.folder} onDone={close} />}
      </Dialog>
    </>
  );
}

function requestKey(request: FolderRequest) {
  return request.kind === "create" ? `create:${request.accountId}:${request.parent?.id ?? ""}` : request.folder.id;
}

function NameTitle({ request }: { request: FolderRequest }) {
  const { t } = useT();
  if (request.kind === "rename") return <>{t("folders.renameTitle")}</>;
  if (request.kind === "create" && request.parent) {
    return <>{t("folders.newIn", { name: folderLabel(request.parent, t) })}</>;
  }
  return <>{t("folders.new")}</>;
}

function folderLabel(folder: Folder, t: (key: string) => string) {
  return folder.role ? t(`folder.${folder.role}`) : folder.name;
}

function NameForm({ request, onDone }: { request: FolderRequest & { kind: "create" | "rename" }; onDone: () => void }) {
  const { t } = useT();
  const refresh = useRefreshMail();
  const [name, setName] = useState(request.kind === "rename" ? request.folder.name : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      if (request.kind === "create") {
        await backend().createFolder({
          accountId: request.accountId,
          name: clean,
          parentId: request.parent?.id ?? null,
        });
        // The new folder shows right away, even inside a folded parent.
        const parentId = request.parent?.id;
        if (parentId && useSettings.getState().collapsedFolders.includes(parentId)) {
          useSettings.getState().toggleFolder(parentId);
        }
        toast(t("folders.created", { name: clean }), "success");
      } else {
        await backend().renameFolder(request.folder.id, clean);
        toast(t("folders.renamed", { name: clean }), "success");
      }
      await refresh();
      onDone();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 px-6 pt-2 pb-6">
      <Field label={t("folders.name")} error={error}>
        {(id) => (
          <TextInput
            id={id}
            value={name}
            autoFocus
            maxLength={200}
            placeholder={t("folders.namePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
          {request.kind === "create" ? t("folders.create") : t("folders.renameConfirm")}
        </Button>
      </div>
    </form>
  );
}

function DeleteQuestion({ folder, onDone }: { folder: Folder; onDone: () => void }) {
  const { t } = useT();
  const refresh = useRefreshMail();
  const [busy, setBusy] = useState(false);
  const name = folderLabel(folder, t);

  const confirm = async () => {
    setBusy(true);
    try {
      await backend().deleteFolder(folder.id);
      const view = useUi.getState().view;
      if (view.kind === "folder" && view.folderId === folder.id) {
        useUi.getState().setView({ kind: "unified", role: "inbox" });
      }
      toast(t("folders.deleted", { name }), "success");
      onDone();
    } catch (reason) {
      toast(message(reason), "error");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-6 text-center">
      <NyuScene name="goodbye" className="w-36" />
      <h2 className="text-[18px] font-extrabold text-balance">{t("folders.deleteTitle", { name })}</h2>
      <p className="text-[13px] text-muted">
        {folder.total > 0 ? t("folders.deleteBody", { count: folder.total }) : t("folders.deleteBodyEmpty")}
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        <Button variant="danger" busy={busy} autoFocus onClick={() => void confirm()}>
          {t("folders.delete")}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

function EmptyQuestion({ folder, onDone }: { folder: Folder; onDone: () => void }) {
  const { t } = useT();
  const refresh = useRefreshMail();
  const [busy, setBusy] = useState(false);
  const junk = folder.role === "junk";

  const confirm = async () => {
    setBusy(true);
    try {
      const removed = await backend().emptyFolder(folder.id);
      useUi.getState().setCheckedThreadIds([]);
      toast(removed > 0 ? t("folders.emptied", { count: removed }) : t("folders.alreadyEmpty"), "success");
      onDone();
    } catch (reason) {
      toast(message(reason), "error");
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-6 text-center">
      <NyuScene name="goodbye" className="w-36" />
      <h2 className="text-[18px] font-extrabold text-balance">
        {junk ? t("folders.emptyJunkTitle") : t("folders.emptyTrashTitle")}
      </h2>
      <p className="text-[13px] text-muted">{t("folders.emptyBody", { count: folder.total })}</p>
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        <Button variant="danger" busy={busy} autoFocus onClick={() => void confirm()}>
          {t("folders.emptyConfirm")}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
