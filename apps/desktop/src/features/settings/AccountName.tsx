import { Button, IconButton, ICONS, TextInput } from "@uwusuite/design";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { backend } from "@/backend/backend";
import type { Account } from "@/backend/types";
import { AccountDot } from "@/components/ui/Avatar";
import { useT } from "@/i18n";
import { accountLabel, hasOwnName } from "@/lib/accountLabel";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";

/**
 * A mailbox in the settings: its name (renamed in place), its address when the name is another,
 * and `details` below.
 */
export function AccountName({ account, details }: { account: Account; details: ReactNode }) {
  const { t } = useT();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const start = () => {
    setName(hasOwnName(account) ? account.name : "");
    setEditing(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      await backend().renameAccount(account.id, name);
      await client.invalidateQueries({ queryKey: queryKeys.accounts });
      toast(t("settings.accountRenamed"), "success");
      setEditing(false);
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 basis-60 items-start gap-3">
      <AccountDot color={account.color} className="mt-1.5 size-3 shrink-0" />
      {editing ? (
        <form
          className="flex min-w-0 flex-1 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextInput
            aria-label={t("settings.accountNameOf", { email: account.email })}
            value={name}
            autoFocus
            maxLength={100}
            placeholder={account.email}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(event) => {
              // Ends the renaming, not the settings around it.
              if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" type="submit" busy={busy}>
              {t("common.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate text-sm font-semibold">{accountLabel(account)}</span>
            <IconButton
              icon={ICONS.edit}
              size="sm"
              label={t("settings.renameAccount")}
              onClick={start}
              className="-my-1"
            />
          </span>
          {hasOwnName(account) && <span className="block truncate text-[12.5px] text-muted">{account.email}</span>}
          <span className="block text-[12.5px] text-muted">{details}</span>
        </span>
      )}
    </div>
  );
}
