import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { Button, Icon, ICONS } from "@uwusuite/design";
import { useState } from "react";
import { backend, BackendError } from "@/backend/backend";
import { translate, useT } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";

/** Mailboxes, calendars and contacts look again once the new sign-in is stored. */
function refreshAfterSignIn(client: QueryClient) {
  return Promise.all(
    [
      queryKeys.accounts,
      queryKeys.folders,
      queryKeys.identities,
      queryKeys.calendarAccounts,
      queryKeys.calendars,
      queryKeys.calendarEvents,
      ["calendarsAvailable"],
      queryKeys.contactsAccounts,
      queryKeys.addressBooks,
      queryKeys.contacts,
      ["contactsAvailable"],
    ].map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}

/**
 * Signs in again in the browser (for a shared mailbox: with its account), for a permission UwUMail
 * asks for now: finding shared mailboxes, calendars, contacts. Says what came of it; mail keeps
 * working whatever it was.
 */
export async function signInAgain(accountId: string, client: QueryClient) {
  try {
    const renewed = await backend().signInAgain(accountId);
    toast(translate("shared.signedInAgain", { email: renewed.email }), "success");
  } catch (error) {
    if (error instanceof BackendError && error.code === "admin_consent_required") {
      toast(translate("cloudSignIn.adminConsent"), "error");
    } else {
      toast(
        translate("cloudSignIn.failed", { reason: error instanceof Error ? error.message : String(error) }),
        "error",
      );
    }
  } finally {
    await refreshAfterSignIn(client);
  }
}

/**
 * A Microsoft or Google sign-in from before calendars and contacts were asked for: "Sign in again"
 * opens the browser, asks for the new permissions, and mail keeps working whatever comes of it.
 */
export function SignInAgainHint({
  accountId,
  name,
  compact = false,
}: {
  accountId: string;
  /** The mailbox's name, where the hint stands outside its settings. */
  name?: string;
  compact?: boolean;
}) {
  const { t } = useT();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    await signInAgain(accountId, client);
    setBusy(false);
  };

  return (
    <div
      role="note"
      className={
        compact
          ? "flex flex-col gap-2 rounded-2xl border border-line bg-pink-tint/35 px-3.5 py-3"
          : "flex flex-col items-start gap-2"
      }
    >
      <p className="flex items-start gap-2 text-[12.5px] break-words text-muted">
        <Icon icon={ICONS.signIn} size="xs" className="mt-0.5 shrink-0" />
        {name ? t("cloudSignIn.hintFor", { name }) : t("cloudSignIn.hint")}
      </p>
      <Button size="sm" variant="primary" busy={busy} onClick={() => void signIn()} className="self-start">
        {t("cloudSignIn.button")}
      </Button>
    </div>
  );
}
