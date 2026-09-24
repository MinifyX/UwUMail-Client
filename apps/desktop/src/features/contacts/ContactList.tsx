import clsx from "clsx";
import { Search, X } from "lucide-react";
import { Fragment, useMemo, type ReactNode } from "react";
import type { ContactRecord } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n";
import { ContactAvatar } from "./ContactAvatar";
import { letterOf, matchesSearch, sortContacts, subtitleOf } from "./format";
import { startNewContact, useContactsUi } from "./state";
import { useContacts } from "./useContactsData";

export const CONTACT_SEARCH_ID = "uwu-contact-search";

/** The contacts of the address book on screen that match the search, in the list's order. */
export function useVisibleContacts(): { contacts: ContactRecord[]; loading: boolean; failed: boolean } {
  const query = useContacts();
  const bookId = useContactsUi((s) => s.bookId);
  const search = useContactsUi((s) => s.search);
  const contacts = useMemo(
    () =>
      sortContacts(
        (query.data ?? []).filter(
          (contact) => (!bookId || contact.addressBookId === bookId) && matchesSearch(contact, search),
        ),
      ),
    [query.data, bookId, search],
  );
  return { contacts, loading: query.isPending, failed: query.isError && !query.data };
}

/** Search and the contacts by letter; a click opens one. */
export function ContactList({ className, header }: { className?: string; header?: ReactNode }) {
  const { t } = useT();
  const search = useContactsUi((s) => s.search);
  const setSearch = useContactsUi((s) => s.setSearch);
  const selectedId = useContactsUi((s) => s.selectedId);
  const select = useContactsUi((s) => s.select);
  const { contacts, loading, failed } = useVisibleContacts();
  const query = useContacts();

  return (
    <section className={clsx("flex min-h-0 flex-col bg-surface", className)} aria-label={t("contacts.title")}>
      <div className="flex flex-col gap-3 px-4 pt-3 pb-3">
        {header}
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            id={CONTACT_SEARCH_ID}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearch("");
                event.currentTarget.blur();
              }
            }}
            placeholder={t("contacts.search")}
            aria-label={t("contacts.search")}
            className="h-10 w-full rounded-full border border-transparent bg-canvas pr-10 pl-10 text-[13.5px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <IconButton
              icon={X}
              size="sm"
              label={t("list.clearSearch")}
              onClick={() => setSearch("")}
              className="absolute top-1/2 right-1 -translate-y-1/2"
            />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {failed ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center">
            <p className="text-[14px] text-muted">{t("contacts.loadFailed")}</p>
            <Button size="sm" onClick={() => void query.refetch()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : loading ? (
          <p className="p-6 text-center text-[13px] text-muted" aria-live="polite">
            {t("contacts.loading")}
          </p>
        ) : contacts.length === 0 ? (
          search ? (
            <EmptyState compact scene="search" title={t("contacts.noMatches")} />
          ) : (
            <EmptyState
              compact
              scene="welcome"
              title={t("contacts.empty.title")}
              body={t("contacts.empty.body")}
              action={
                <Button variant="primary" size="sm" onClick={() => startNewContact()}>
                  {t("contacts.newContact")}
                </Button>
              }
            />
          )
        ) : (
          <ul className="flex flex-col" aria-label={t("contacts.title")}>
            {contacts.map((contact, index) => {
              const letter = letterOf(contact);
              const newLetter = index === 0 || letterOf(contacts[index - 1]!) !== letter;
              const subtitle = subtitleOf(contact);
              return (
                <Fragment key={contact.id}>
                  {newLetter && !search && (
                    <li
                      aria-hidden
                      className="sticky top-0 z-[1] bg-surface/95 px-3 pt-3 pb-1 text-[12px] font-bold text-pink-ink backdrop-blur-sm"
                    >
                      {letter}
                    </li>
                  )}
                  <li>
                    <button
                      type="button"
                      onClick={() => select(contact.id)}
                      aria-current={selectedId === contact.id ? "true" : undefined}
                      className={clsx(
                        "flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors",
                        selectedId === contact.id ? "bg-pink-tint" : "hover:bg-pink-tint/50",
                      )}
                    >
                      <ContactAvatar contact={contact} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[14px] font-semibold">
                          {contact.displayName || t("contacts.nameless")}
                        </span>
                        {subtitle && <span className="truncate text-[12.5px] text-muted">{subtitle}</span>}
                      </span>
                    </button>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {!loading && search ? t("contacts.matches", { count: contacts.length }) : ""}
      </p>
    </section>
  );
}
