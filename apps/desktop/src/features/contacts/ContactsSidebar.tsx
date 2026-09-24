import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { BookUser, Ellipsis, Plus, Settings, Star, UsersRound, UserPlus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { AddressBookInfo } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { Wordmark } from "@/components/ui/Logo";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { useT } from "@/i18n";
import { queryKeys, useAccounts } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { AppSwitch } from "../shell/AppSwitch";
import { startNewContact, useContactsUi } from "./state";
import { useAddressBooks, useContacts, useContactsAccounts } from "./useContactsData";

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

function SidebarLink({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-9 w-full items-center gap-3 rounded-xl px-3 text-left text-[13.5px] text-ink/85 transition-colors hover:bg-pink-tint/50"
    >
      <Icon className="size-[17px] shrink-0 text-muted" strokeWidth={2} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** Beside the contacts: the switch back to mail, a new contact and the address books. */
export function ContactsSidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const { t } = useT();
  const openSettings = useUi((s) => s.openSettings);
  return (
    <nav className={clsx("flex h-full flex-col gap-4 px-3 pt-4 pb-3", className)} aria-label={t("contacts.title")}>
      <div className="flex items-center justify-between px-2">
        <Wordmark className="text-[19px]" />
      </div>
      <AppSwitch />
      <Button
        variant="primary"
        size="lg"
        icon={UserPlus}
        onClick={() => {
          onNavigate?.();
          startNewContact();
        }}
        className="w-full"
      >
        {t("contacts.newContact")}
      </Button>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
        <AddressBookList onNavigate={onNavigate} />
      </div>
      <div className="flex flex-col gap-0.5 border-t border-hairline pt-3">
        <SidebarLink icon={Settings} label={t("nav.settings")} onClick={() => openSettings()} />
      </div>
    </nav>
  );
}

/** All contacts, then each address book with its count, by mailbox; "…" to rename, make default or delete. */
function AddressBookList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useT();
  const client = useQueryClient();
  const { data: books = [] } = useAddressBooks();
  const { data: contacts = [] } = useContacts();
  const { data: accounts = [] } = useAccounts();
  const { data: sources = [] } = useContactsAccounts();
  const bookId = useContactsUi((s) => s.bookId);
  const setBook = useContactsUi((s) => s.setBook);
  const [editing, setEditing] = useState<AddressBookInfo | "new" | null>(null);
  const [deleting, setDeleting] = useState<AddressBookInfo | null>(null);
  // The app holds several mailboxes: their address books come grouped, in the accounts' order.
  const groups = accounts
    .map((account) => ({
      accountId: account.id,
      name: account.name || account.email,
      books: books.filter((book) => book.accountId === account.id),
    }))
    .filter((group) => group.books.length > 0);
  // New address books can go to every mailbox that has address books.
  const creatable = accounts
    .filter((account) => sources.some((source) => source.accountId === account.id && source.source !== null))
    .map((account) => ({ id: account.id, name: account.name || account.email }));
  const booksOf = (accountId: string) => books.filter((book) => book.accountId === accountId);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action();
      if (success) toast(success, "success");
      return true;
    } catch (error) {
      toast(t("contacts.toast.failed", { reason: reason(error) }), "error");
      return false;
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.addressBooks }),
        client.invalidateQueries({ queryKey: queryKeys.contacts }),
      ]);
    }
  };
  const count = (id: string | null) => contacts.filter((contact) => !id || contact.addressBookId === id).length;
  const pick = (id: string | null) => {
    setBook(id);
    onNavigate?.();
  };
  const menuItems = (book: AddressBookInfo): MenuItem[] => [
    ...(book.mayWrite ? [{ label: t("contacts.renameBook"), onSelect: () => setEditing(book) }] : []),
    ...(!book.isDefault && book.mayWrite
      ? [
          {
            label: t("contacts.makeDefault"),
            onSelect: () =>
              void run(
                () => backend().setDefaultAddressBook(book.id),
                t("contacts.toast.defaultSet", { name: book.name }),
              ),
          },
        ]
      : []),
    // Every mailbox keeps at least one address book.
    ...(book.mayDelete && booksOf(book.accountId).length > 1
      ? [{ label: t("contacts.deleteBook"), danger: true, onSelect: () => setDeleting(book) }]
      : []),
  ];
  const rows = (list: AddressBookInfo[]) =>
    list.map((book) => (
      <BookRow
        key={book.id}
        icon={BookUser}
        name={book.name}
        count={count(book.id)}
        selected={bookId === book.id}
        isDefault={book.isDefault && booksOf(book.accountId).length > 1}
        items={menuItems(book)}
        menuLabel={t("contacts.bookActions", { name: book.name })}
        onPick={() => pick(book.id)}
      />
    ));

  return (
    <section className="flex flex-col gap-0.5" aria-labelledby="uwu-address-books">
      <ul className="flex flex-col gap-0.5">
        <BookRow
          icon={UsersRound}
          name={t("contacts.all")}
          count={count(null)}
          selected={bookId === null}
          items={[]}
          onPick={() => pick(null)}
        />
      </ul>
      <div className="flex items-center justify-between pt-3 pr-1 pl-3">
        <h2 id="uwu-address-books" className="text-[12px] font-bold tracking-wide text-muted uppercase">
          {t("contacts.addressBooks")}
        </h2>
        {creatable.length > 0 && (
          <IconButton icon={Plus} size="sm" label={t("contacts.newBook")} onClick={() => setEditing("new")} />
        )}
      </div>
      {groups.length > 1 ? (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
            <li key={group.accountId}>
              <p
                id={`uwu-address-books-${group.accountId}`}
                className="truncate px-3 pb-0.5 text-[12px] font-semibold text-muted"
              >
                {group.name}
              </p>
              <ul className="flex flex-col gap-0.5" aria-labelledby={`uwu-address-books-${group.accountId}`}>
                {rows(group.books)}
              </ul>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="flex flex-col gap-0.5">{rows(books)}</ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} width="sm">
        {editing !== null && (
          <BookForm
            key={editing === "new" ? "new" : editing.id}
            book={editing === "new" ? null : editing}
            accounts={creatable}
            defaultAccount={
              books.find((book) => book.isDefault && creatable.some((a) => a.id === book.accountId))?.accountId ??
              creatable[0]?.id
            }
            onDone={async (name, accountId) => {
              const ok = await run(
                () =>
                  editing === "new"
                    ? backend().createAddressBook(name, accountId)
                    : backend().renameAddressBook(editing.id, name),
                editing === "new" ? t("contacts.toast.bookCreated", { name }) : undefined,
              );
              if (ok) setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        )}
      </Dialog>

      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} width="sm">
        {deleting && (
          <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
            <NyuScene name="goodbye" className="w-36" />
            <h2 className="text-[18px] font-extrabold text-balance">
              {t("contacts.deleteBookTitle", { name: deleting.name })}
            </h2>
            <p className="text-[13px] text-muted">{t("contacts.deleteBookBody", { count: count(deleting.id) })}</p>
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              <Button
                variant="danger"
                autoFocus
                onClick={() => {
                  const book = deleting;
                  setDeleting(null);
                  if (bookId === book.id) setBook(null);
                  void run(
                    () => backend().deleteAddressBook(book.id),
                    t("contacts.toast.bookDeleted", { name: book.name }),
                  );
                }}
              >
                {t("contacts.deleteBook")}
              </Button>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </section>
  );
}

/** One line of the list: an address book (or all contacts) with its count, and its "…" menu. */
function BookRow({
  icon: Icon,
  name,
  count,
  selected,
  isDefault = false,
  items,
  menuLabel,
  onPick,
}: {
  icon: LucideIcon;
  name: string;
  count: number;
  selected: boolean;
  isDefault?: boolean;
  items: MenuItem[];
  menuLabel?: string;
  onPick: () => void;
}) {
  const { t } = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li
      className={clsx(
        "group relative flex h-9 items-center gap-2 rounded-xl pr-1 pl-3",
        selected ? "bg-pink-tint text-pink-ink" : "hover:bg-pink-tint/50",
      )}
      onContextMenu={(event) => {
        if (items.length === 0) return;
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      <button
        type="button"
        aria-current={selected ? "page" : undefined}
        onClick={onPick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left text-[13.5px]"
      >
        <Icon className="size-[17px] shrink-0 opacity-80" strokeWidth={2} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
        {isDefault && (
          <span className="shrink-0 text-muted" title={t("contacts.default")}>
            <Star className="size-3.5" strokeWidth={2.2} aria-hidden />
            <span className="sr-only">{t("contacts.default")}</span>
          </span>
        )}
        <span className="shrink-0 text-[12px] text-muted tabular-nums">{count}</span>
      </button>
      {items.length > 0 && (
        <Menu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          align="end"
          items={items}
          trigger={({ toggle, ...aria }) => (
            <IconButton
              icon={Ellipsis}
              size="sm"
              label={menuLabel ?? name}
              onClick={toggle}
              className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              {...aria}
            />
          )}
        />
      )}
    </li>
  );
}

function BookForm({
  book,
  accounts,
  defaultAccount,
  onDone,
  onCancel,
}: {
  book: AddressBookInfo | null;
  /** The mailboxes a new address book can go to. */
  accounts: { id: string; name: string }[];
  defaultAccount?: string;
  onDone: (name: string, accountId?: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(book?.name ?? "");
  const [accountId, setAccountId] = useState(defaultAccount ?? accounts[0]?.id);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const empty = !name.trim();
  return (
    <form
      className="flex flex-col gap-4 px-6 pt-5 pb-6"
      onSubmit={async (event) => {
        event.preventDefault();
        setTried(true);
        if (empty) return;
        setBusy(true);
        await onDone(name.trim(), book ? undefined : accountId);
        setBusy(false);
      }}
    >
      <h2 className="text-lg font-bold">{book ? t("contacts.renameBook") : t("contacts.newBook")}</h2>
      <Field label={t("contacts.bookName")} error={tried && empty ? t("contacts.problem.bookName") : undefined}>
        {(id) => (
          <TextInput id={id} autoFocus value={name} maxLength={255} onChange={(event) => setName(event.target.value)} />
        )}
      </Field>
      {!book && accounts.length > 1 && (
        <Field label={t("contacts.mailbox")}>
          {(id) => (
            <Select id={id} value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {book ? t("common.save") : t("contacts.create")}
        </Button>
      </div>
    </form>
  );
}
