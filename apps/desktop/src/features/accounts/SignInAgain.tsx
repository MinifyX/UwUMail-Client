import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { backend, BackendError } from "@/backend/backend";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { toast } from "@/state/toasts";

/** Calendars and contacts look again once the new sign-in is stored. */
function refreshCloud(client: QueryClient) {
  return Promise.all(
    [
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
    try {
      await backend().signInAgain(accountId);
      toast(t("cloudSignIn.done"), "success");
    } catch (error) {
      if (error instanceof BackendError && error.code === "admin_consent_required") {
        toast(t("cloudSignIn.adminConsent"), "error");
      } else {
        toast(t("cloudSignIn.failed", { reason: error instanceof Error ? error.message : String(error) }), "error");
      }
    } finally {
      setBusy(false);
      await refreshCloud(client);
    }
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
        <KeyRound className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {name ? t("cloudSignIn.hintFor", { name }) : t("cloudSignIn.hint")}
      </p>
      <Button size="sm" variant="primary" busy={busy} onClick={() => void signIn()} className="self-start">
        {t("cloudSignIn.button")}
      </Button>
    </div>
  );
}
