import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { backend, BackendError } from "@/backend/backend";
import type { Account } from "@/backend/types";
import { ArmedButton } from "@/components/ui/ArmedButton";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, TextInput } from "@/components/ui/Field";
import { translate, useT } from "@/i18n";
import { queryKeys, useAccounts } from "@/lib/queries";
import { startAccountSync, useAccountSync } from "@/state/accountSync";
import { useSettings } from "@/state/settings";
import { sharedOf, useSharedMailboxes } from "@/state/sharedMailboxes";
import { toast } from "@/state/toasts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function refreshAccounts(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.accounts }),
    client.invalidateQueries({ queryKey: queryKeys.folders }),
    client.invalidateQueries({ queryKey: queryKeys.identities }),
  ]);
}

/** Searches a Microsoft 365 account for its shared mailboxes now and says what came of it. */
export async function searchSharedMailboxes(account: Account, client: QueryClient) {
  try {
    const result = await backend().findSharedMailboxes(account.id);
    await refreshAccounts(client);
    if (result.state === "needsSignIn") toast(translate("shared.stateNeedsSignIn"), "info");
    else if (result.state === "unavailable") toast(translate("shared.stateUnavailable"), "info");
    else if (result.added.length > 0) toast(translate("shared.found", { count: result.added.length }), "success");
    else toast(translate("shared.foundNone"), "info");
  } catch (reason) {
    toast(message(reason), "error");
  }
}

/** Adding a shared mailbox by address, and removing mailboxes with or without their shared ones. Mount once. */
export function SharedMailboxDialogs() {
  const request = useSharedMailboxes((s) => s.request);
  const close = useSharedMailboxes((s) => s.close);
  const { t } = useT();
  return (
    <>
      <Dialog open={request?.kind === "add"} onClose={close} width="sm" title={t("shared.addTitle")}>
        {request?.kind === "add" && <AddForm key={request.parent.id} parent={request.parent} onDone={close} />}
      </Dialog>
      <Dialog open={request?.kind === "remove"} onClose={close} width="sm">
        {request?.kind === "remove" && (
          <RemoveQuestion key={request.account.id} account={request.account} onDone={close} />
        )}
      </Dialog>
    </>
  );
}

function AddForm({ parent, onDone }: { parent: Account; onDone: () => void }) {
  const { t } = useT();
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const added = await backend().addSharedMailbox(parent.id, address, name.trim() || undefined);
      await refreshAccounts(client);
      toast(t("shared.added", { email: added.email }), "success");
      onDone();
    } catch (reason) {
      setError(
        reason instanceof BackendError && reason.code === "auth_failed"
          ? t("shared.noAccess", { email: address, account: parent.email })
          : message(reason),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 px-6 pt-2 pb-6">
      <p className="text-[13.5px] text-muted">{t("shared.addIntro", { email: parent.email })}</p>
      <Field label={t("shared.address")} error={error}>
        {(id) => (
          <TextInput
            id={id}
            type="email"
            autoComplete="off"
            autoFocus
            value={email}
            placeholder={t("shared.addressPlaceholder")}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <Field label={t("shared.displayName")}>
        {(id) => (
          <TextInput
            id={id}
            value={name}
            maxLength={200}
            placeholder={t("shared.displayNamePlaceholder")}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!email.trim()}>
          {t("shared.addConfirm")}
        </Button>
      </div>
    </form>
  );
}

/** In the app, not the system's question: "Remove" only answers once the gesture that asked is over (security-audit C-10). */
function RemoveQuestion({ account, onDone }: { account: Account; onDone: () => void }) {
  const { t } = useT();
  const client = useQueryClient();
  const { data: accounts = [] } = useAccounts();
  const shared = sharedOf(accounts, account.id);
  const [withShared, setWithShared] = useState(true);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      const keepShared = shared.length > 0 && !withShared;
      await backend().removeAccount(account.id, { keepShared });
      const settings = useSettings.getState();
      const gone = [account, ...(keepShared ? [] : shared)];
      for (const removed of gone) settings.setAccountWorkspace(removed.id, "private");
      await client.invalidateQueries();
      // Another account may carry the settings now.
      if (gone.some((removed) => useAccountSync.getState().accountId === removed.id)) void startAccountSync();
      onDone();
    } catch (reason) {
      toast(message(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-6 text-center">
      <p className="text-[15px] font-semibold text-balance break-words">
        {account.parentId
          ? t("shared.removeConfirm", { email: account.email })
          : t("settings.removeAccountConfirm", { email: account.email })}
      </p>
      {shared.length > 0 && (
        <label className="flex items-center gap-2.5 text-left text-[13.5px]">
          <input
            type="checkbox"
            checked={withShared}
            onChange={(event) => setWithShared(event.target.checked)}
            className="size-4 accent-pink"
          />
          <span>{t("shared.removeWithShared", { count: shared.length })}</span>
        </label>
      )}
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        <Button variant="ghost" autoFocus onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <ArmedButton variant="danger" busy={busy} onClick={() => void remove()}>
          {account.parentId ? t("shared.remove") : t("settings.removeAccount")}
        </ArmedButton>
      </div>
    </div>
  );
}
