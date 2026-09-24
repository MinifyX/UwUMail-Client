import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { Account, ContactsAccount } from "@/backend/types";
import { Button } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { useContactsAccounts } from "../contacts/useContactsData";
import { caldavUrlProblem } from "./AccountCalendar";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Settings → Mailboxes, per mailbox: where its address books come from (the UwUMail server,
 * CardDAV, or why there are none), and a CardDAV address for servers UwUMail doesn't find by itself.
 */
export function AccountContacts({ account }: { account: Account }) {
  const { t } = useT();
  const { data: sources, isPending, isFetching } = useContactsAccounts();
  const source = sources?.find((entry) => entry.accountId === account.id);
  return (
    <div className="flex basis-full flex-col gap-2.5 border-t border-hairline pt-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-muted">{t("accountContacts.title")}</span>
        <span className="min-w-0 text-right text-[13px]" aria-live="polite">
          {isPending || (isFetching && !source) ? (
            <span className="text-muted">{t("accountContacts.checking")}</span>
          ) : (
            <SourceLabel source={source} />
          )}
        </span>
      </div>
      {source && source.source === null && (source.problem || account.auth !== "password") && (
        <p className="text-[12.5px] break-words text-muted">
          {/* Sign-ins get the known reason in the app's language; for the rest, what the discovery ran into. */}
          {account.auth === "password" ? source.problem : t("accountContacts.signIn")}
        </p>
      )}
      {/* Microsoft and Google sign-ins can't log in to CardDAV; the UwUMail server has its own address books. */}
      {account.auth === "password" && source && source.source !== "jmap" && (
        <CardDavUrl key={source.carddavUrl ?? ""} account={account} source={source} />
      )}
    </div>
  );
}

function SourceLabel({ source }: { source: ContactsAccount | undefined }) {
  const { t } = useT();
  if (source?.source === "jmap") return <span className="font-semibold">{t("accountContacts.source.jmap")}</span>;
  if (source?.source === "carddav") return <span className="font-semibold">{t("accountContacts.source.carddav")}</span>;
  return <span className="text-muted">{t("accountContacts.unavailable")}</span>;
}

function CardDavUrl({ account, source }: { account: Account; source: ContactsAccount }) {
  const { t } = useT();
  const client = useQueryClient();
  const saved = source.carddavUrl ?? "";
  const [text, setText] = useState(saved);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<"save" | "clear" | "check" | null>(null);
  const trimmed = text.trim();
  const problem = trimmed ? caldavUrlProblem(trimmed) : null;
  const changed = trimmed !== saved;

  /** Stores the address (null: none) and looks for the address books again; says what came of it. */
  const apply = async (url: string | null, kind: "save" | "clear" | "check") => {
    setBusy(kind);
    try {
      await backend().setCardDavUrl(account.id, url);
    } catch (error) {
      toast(t("accountContacts.failed", { reason: reason(error) }), "error");
      setBusy(null);
      return;
    }
    await Promise.all([
      client.invalidateQueries({ queryKey: ["contactsAvailable"] }),
      client.invalidateQueries({ queryKey: queryKeys.addressBooks }),
      client.invalidateQueries({ queryKey: queryKeys.contacts }),
    ]);
    const found = await client.fetchQuery({
      queryKey: queryKeys.contactsAccounts,
      queryFn: () => backend().contactsAccounts(),
      staleTime: 0,
    });
    setBusy(null);
    const now = found.find((entry) => entry.accountId === account.id);
    if (now?.source) toast(t("accountContacts.found"), "success");
    else if (kind === "clear") toast(t("accountContacts.cleared"), "info");
    else toast(t("accountContacts.notFound", { reason: now?.problem ?? "" }), "error");
  };

  return (
    <form
      className="flex flex-col gap-2"
      // The browser's own check would stand in for the explanation below the field.
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (!trimmed || problem) return;
        void apply(trimmed, "save");
      }}
    >
      <Field
        label={t("accountContacts.url")}
        hint={t("accountContacts.urlHint")}
        error={tried && problem ? t(`accountCalendar.problem.${problem}`) : undefined}
      >
        {(id) => (
          <TextInput
            id={id}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://dav.example.com/"
            value={text}
            aria-invalid={tried && problem !== null}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        {changed && trimmed && (
          <Button type="submit" size="sm" variant="primary" busy={busy === "save"} disabled={busy !== null}>
            {t("common.save")}
          </Button>
        )}
        <Button
          size="sm"
          busy={busy === "check"}
          disabled={busy !== null}
          onClick={() => void apply(saved || null, "check")}
        >
          {t("accountContacts.check")}
        </Button>
        {saved && (
          <Button
            size="sm"
            variant="ghost"
            busy={busy === "clear"}
            disabled={busy !== null}
            onClick={() => void apply(null, "clear")}
          >
            {t("accountContacts.clear")}
          </Button>
        )}
      </div>
    </form>
  );
}
