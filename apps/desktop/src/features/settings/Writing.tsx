import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { backend } from "@/backend/backend";
import type { Account, Identity } from "@/backend/types";
import { AccountDot } from "@/components/ui/Avatar";
import { Button, IconButton } from "@/components/ui/Button";
import { Segmented, TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { queryKeys, useAccounts, useIdentities } from "@/lib/queries";
import { UNDO_SEND_CHOICES, useSettings, type UndoSendSeconds } from "@/state/settings";
import { toast } from "@/state/toasts";
import { Row } from "./Row";
import { Signatures } from "./Signatures";

export function Writing() {
  const { t } = useT();
  const undoSendSeconds = useSettings((s) => s.undoSendSeconds);
  const update = useSettings((s) => s.update);
  return (
    <>
      <Row label={t("settings.undoSend")} description={t("settings.undoSendDesc")}>
        <Segmented
          label={t("settings.undoSend")}
          value={String(undoSendSeconds)}
          onChange={(value) => update({ undoSendSeconds: Number(value) as UndoSendSeconds })}
          options={UNDO_SEND_CHOICES.map((seconds) => ({
            value: String(seconds),
            label: seconds === 0 ? t("settings.undoSendOff") : t("settings.seconds", { count: seconds }),
          }))}
        />
      </Row>
      <Senders />
      <Signatures />
    </>
  );
}

function Senders() {
  const { t } = useT();
  const { data: accounts = [] } = useAccounts();
  const { data: identities = [] } = useIdentities();
  return (
    <Row label={t("settings.senders")} description={t("settings.sendersDesc")}>
      <div className="flex flex-col gap-3">
        {accounts.map((account) => (
          <AccountSenders
            key={account.id}
            account={account}
            identities={identities.filter((identity) => identity.accountId === account.id)}
          />
        ))}
      </div>
    </Row>
  );
}

function AccountSenders({ account, identities }: { account: Account; identities: Identity[] }) {
  const { t } = useT();
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState(account.displayName);
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.identities }),
      client.invalidateQueries({ queryKey: queryKeys.accounts }),
    ]);
  const failed = (reason: unknown) => toast(reason instanceof Error ? reason.message : String(reason), "error");

  const add = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const identity = await backend().addIdentity(account.id, email, name);
      toast(t("settings.senderAdded", { email: identity.email }), "success");
      setEmail("");
      setAdding(false);
      await refresh();
    } catch (reason) {
      failed(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-hairline p-2">
      <h3 className="flex items-center gap-2 px-2 pt-1 pb-2 text-[13px] font-semibold text-muted">
        <AccountDot color={account.color} />
        <span className="truncate">{account.email}</span>
      </h3>
      <ul className="flex flex-col gap-1">
        {identities.map((identity) => (
          <li key={identity.id} className="flex flex-wrap items-center gap-2 rounded-xl px-2 py-1 hover:bg-elevated">
            <span className="min-w-0 flex-1 basis-40">
              <span className="selectable block truncate text-[13.5px] font-semibold">{identity.email}</span>
              <span className="block text-[12px] text-muted">
                {identity.primary
                  ? t("settings.senderOwn")
                  : identity.fromServer
                    ? t("settings.senderFromServer")
                    : t("settings.senderManual")}
              </span>
            </span>
            <TextInput
              aria-label={t("settings.senderNameFor", { email: identity.email })}
              placeholder={t("settings.senderName")}
              defaultValue={identity.name}
              onBlur={(event) => {
                const value = event.currentTarget.value.trim();
                if (value === identity.name) return;
                void backend().renameIdentity(identity.id, value).then(refresh, failed);
              }}
              className="h-9 max-w-56 min-w-0 flex-1 basis-32"
            />
            {!identity.primary && !identity.fromServer ? (
              <IconButton
                icon={X}
                size="sm"
                label={t("settings.removeSender", { email: identity.email })}
                onClick={() => void backend().removeIdentity(identity.id).then(refresh, failed)}
              />
            ) : (
              <span className="size-8 shrink-0" aria-hidden />
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <form onSubmit={(event) => void add(event)} className="flex flex-wrap items-center gap-2 px-2 pt-2 pb-1">
          <TextInput
            type="email"
            required
            autoFocus
            aria-label={t("settings.senderEmail")}
            placeholder={t("settings.senderEmail")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-9 min-w-0 flex-1 basis-48"
          />
          <TextInput
            aria-label={t("settings.senderName")}
            placeholder={t("settings.senderName")}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-9 min-w-0 flex-1 basis-32"
          />
          <Button type="submit" size="sm" variant="primary" busy={busy}>
            {t("settings.addSender")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
            {t("common.cancel")}
          </Button>
        </form>
      ) : (
        <Button size="sm" variant="ghost" icon={Plus} className="mt-1" onClick={() => setAdding(true)}>
          {t("settings.addSender")}
        </Button>
      )}
    </section>
  );
}
