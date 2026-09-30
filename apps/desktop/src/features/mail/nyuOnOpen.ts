import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { backend } from "@/backend/backend";
import type { ThreadDetail } from "@/backend/types";
import { playFirstNyu } from "@/components/nyu/cameo";
import { useNyuLevel } from "@/components/nyu/level";
import { openCameos } from "@/components/nyu/occasions";
import { useAccounts, queryKeys } from "@/lib/queries";
import { useContactsAvailable, useLoadedContacts } from "../contacts/useContactsData";

/** How long a mail waits for the contacts before Nyu greets it without them. */
const CONTACTS_WAIT_MS = 2500;

/**
 * The contacts Nyu may look at when a mail opens: all of them once the contacts were loaded,
 * else those of the mailboxes whose address books are known already. Opening a mail never
 * searches for an address book server (a foreign IMAP mailbox's CardDAV waits for the contacts).
 * `ready` once it is known which there are (none counts too).
 */
function useNyuContacts(enabled: boolean) {
  const available = useContactsAvailable();
  const { data: loaded } = useLoadedContacts();
  const wanted = enabled && available.data === true && !loaded;
  const known = useQuery({
    // Under the contacts' key, so a change to the contacts refreshes it too.
    queryKey: [...queryKeys.contacts, "known"],
    queryFn: () => backend().knownContacts(),
    enabled: wanted,
    staleTime: 10 * 60_000,
  });
  const ready = !enabled || !!loaded || (!available.isPending && (!wanted || known.isFetched));
  return { contacts: loaded ?? known.data ?? [], ready };
}

/**
 * Nyu greets a mail once it has opened: with a party hat on the sender's birthday, hearts for new
 * mail from a contact, a camera for photos, a nightcap late at night, or else it peeks and reads
 * along (see components/nyu/occasions). Once per conversation, when it and the contacts have
 * loaded (at most CONTACTS_WAIT_MS later).
 */
export function useNyuOnOpen(detail: ThreadDetail | undefined): void {
  const level = useNyuLevel();
  const { data: accounts, isSuccess: accountsReady } = useAccounts();
  const { contacts, ready: contactsReady } = useNyuContacts(level !== "off");
  const threadId = detail?.thread.id;
  const greeted = useRef<string | null>(null);
  // Whether it was new as the conversation first arrived: opening it marks it read soon after.
  const arrived = useRef<{ threadId: string; unread: boolean } | null>(null);
  useEffect(() => {
    if (detail && threadId) {
      arrived.current = { threadId, unread: detail.messages.some((message) => !message.flags.seen) };
    }
    // The first copy of each conversation only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);
  const [waited, setWaited] = useState<string | null>(null);

  useEffect(() => {
    if (!threadId || contactsReady) return;
    const timer = setTimeout(() => setWaited(threadId), CONTACTS_WAIT_MS);
    return () => clearTimeout(timer);
  }, [threadId, contactsReady]);

  const ready = accountsReady && (contactsReady || waited === threadId);
  useEffect(() => {
    if (!detail || !threadId || level === "off" || !ready || greeted.current === threadId) return;
    greeted.current = threadId;
    // Every mailbox in the app is the person's own, UwUMail or not.
    const own = new Set((accounts ?? []).map((account) => account.email.toLowerCase()));
    const { messages } = detail;
    const latest = messages.findLast((message) => !own.has(message.from.email.toLowerCase())) ?? messages.at(-1);
    if (!latest) return;
    playFirstNyu(
      openCameos(
        {
          from: own.has(latest.from.email.toLowerCase()) ? "" : latest.from.email,
          unread: arrived.current?.threadId === threadId && arrived.current.unread,
          attachments: messages.flatMap((message) => message.attachments),
        },
        contacts,
        new Date(),
      ),
    );
    // Once per conversation, as soon as everything is there; not again on refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, ready, level]);
}
