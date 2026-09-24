import { Plus, Trash, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ContactEmail,
  ContactInput,
  ContactKind,
  ContactPhone,
  ContactPostal,
  ContactRecord,
} from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDiscardDialog } from "@/components/ui/ConfirmDiscardDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Select, TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { useAccounts } from "@/lib/queries";
import { formatBirthday, hasName, inputFrom } from "./format";
import { useContactsUi, type ContactEditorRequest } from "./state";
import { useAddressBooks, useContactActions } from "./useContactsData";

const KINDS: ContactKind[] = ["home", "work", "other"];
const PHONE_KINDS: ContactPhone["kind"][] = ["mobile", "home", "work", "other"];

/** Name, company, addresses, numbers, birthday and a note. Mounted once, for the contacts and the mail. */
export function ContactEditor() {
  const request = useContactsUi((s) => s.editor);
  const close = useContactsUi((s) => s.closeEditor);
  const key = request ? (request.contact?.id ?? `new:${request.draft?.emails?.[0] ?? ""}`) : "closed";
  return <EditorDialog key={key} request={request} onClose={close} />;
}

function EditorDialog({ request, onClose }: { request: ContactEditorRequest | null; onClose: () => void }) {
  const { t, i18n } = useT();
  const { data: allBooks = [] } = useAddressBooks();
  const { data: accounts = [] } = useAccounts();
  const chosenBook = useContactsUi((s) => s.bookId);
  // Only address books it may write to, and a contact stays in its own mailbox.
  const books = allBooks.filter(
    (book) => book.mayWrite && (!request?.contact || book.accountId === request.contact.accountId),
  );
  const fallback = books.find((book) => book.id === chosenBook) ?? books.find((book) => book.isDefault) ?? books[0];
  const several = new Set(books.map((book) => book.accountId)).size > 1;
  const bookLabel = (book: (typeof books)[number]) => {
    if (!several) return book.name;
    const account = accounts.find((a) => a.id === book.accountId);
    return `${book.name} · ${account?.name || account?.email || book.accountId}`;
  };
  const [form, setFormState] = useState<ContactInput | null>(() =>
    request ? inputFrom(request.contact, fallback?.id ?? "", request.draft) : null,
  );
  const [dirty, setDirty] = useState(false);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const actions = useContactActions();
  if (!request || !form)
    return (
      <Dialog open={false} onClose={onClose}>
        {null}
      </Dialog>
    );

  const contact: ContactRecord | null = request.contact;
  const bookId = form.addressBookId || fallback?.id || "";
  const nameless = !hasName(form);
  const setForm = (patch: Partial<ContactInput>) => {
    setDirty(true);
    setFormState({ ...form, ...patch });
  };
  const requestClose = () => (dirty ? setAsking(true) : onClose());

  const save = async () => {
    setTried(true);
    if (nameless || !bookId) return;
    setBusy(true);
    const input = { ...form, addressBookId: bookId };
    const saved = contact ? await actions.update(contact, input) : await actions.create(input);
    setBusy(false);
    if (saved) onClose();
  };

  // Year-less birthdays can't be shown in a date field; they stay unless a date is picked.
  const yearless = form.birthday?.startsWith("--") ?? false;

  return (
    <>
      <Dialog
        open
        onClose={requestClose}
        closeOnOutsideClick={!dirty}
        title={contact ? t("contacts.editContact") : t("contacts.newContact")}
        width="md"
      >
        <form
          className="flex flex-col gap-4 px-6 pt-2 pb-6"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("contacts.given")}>
              {(id) => (
                <TextInput
                  id={id}
                  autoFocus
                  autoComplete="off"
                  value={form.given}
                  maxLength={200}
                  aria-invalid={tried && nameless}
                  onChange={(event) => setForm({ given: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("contacts.surname")}>
              {(id) => (
                <TextInput
                  id={id}
                  autoComplete="off"
                  value={form.surname}
                  maxLength={200}
                  onChange={(event) => setForm({ surname: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("contacts.organization")}>
              {(id) => (
                <TextInput
                  id={id}
                  autoComplete="off"
                  value={form.organization}
                  maxLength={200}
                  onChange={(event) => setForm({ organization: event.target.value })}
                />
              )}
            </Field>
            <Field label={t("contacts.jobTitle")}>
              {(id) => (
                <TextInput
                  id={id}
                  autoComplete="off"
                  value={form.title}
                  maxLength={200}
                  onChange={(event) => setForm({ title: event.target.value })}
                />
              )}
            </Field>
          </div>
          {tried && nameless && (
            <p role="alert" className="-mt-2 text-[13px] text-danger">
              {t("contacts.problem.name")}
            </p>
          )}

          <Rows
            legend={t("contacts.emails")}
            addLabel={t("contacts.addEmail")}
            items={form.emails}
            onChange={(emails) => setForm({ emails })}
            blank={(): ContactEmail => ({ id: "", address: "", kind: "other" })}
            render={(email, change) => (
              <>
                <TextInput
                  type="email"
                  autoComplete="off"
                  aria-label={t("contacts.email")}
                  value={email.address}
                  maxLength={320}
                  onChange={(event) => change({ ...email, address: event.target.value })}
                />
                <KindSelect
                  kinds={KINDS}
                  value={email.kind}
                  onChange={(kind) => change({ ...email, kind: kind as ContactKind })}
                />
              </>
            )}
          />

          <Rows
            legend={t("contacts.phones")}
            addLabel={t("contacts.addPhone")}
            items={form.phones}
            onChange={(phones) => setForm({ phones })}
            blank={(): ContactPhone => ({ id: "", number: "", kind: "mobile" })}
            render={(phone, change) => (
              <>
                <TextInput
                  type="tel"
                  autoComplete="off"
                  aria-label={t("contacts.phone")}
                  value={phone.number}
                  maxLength={100}
                  onChange={(event) => change({ ...phone, number: event.target.value })}
                />
                <KindSelect
                  kinds={PHONE_KINDS}
                  value={phone.kind}
                  onChange={(kind) => change({ ...phone, kind: kind as ContactPhone["kind"] })}
                />
              </>
            )}
          />

          <Rows
            legend={t("contacts.addresses")}
            addLabel={t("contacts.addAddress")}
            items={form.addresses}
            onChange={(addresses) => setForm({ addresses })}
            blank={(): ContactPostal => ({
              id: "",
              street: "",
              postcode: "",
              locality: "",
              region: "",
              country: "",
              kind: "home",
            })}
            render={(postal, change) => (
              <div className="grid min-w-0 flex-1 grid-cols-[6rem_minmax(0,1fr)] gap-2">
                <span className="col-span-2 flex gap-2">
                  <TextInput
                    aria-label={t("contacts.street")}
                    placeholder={t("contacts.street")}
                    value={postal.street}
                    maxLength={300}
                    onChange={(event) => change({ ...postal, street: event.target.value })}
                  />
                  <KindSelect
                    kinds={KINDS}
                    value={postal.kind}
                    onChange={(kind) => change({ ...postal, kind: kind as ContactKind })}
                  />
                </span>
                <TextInput
                  aria-label={t("contacts.postcode")}
                  placeholder={t("contacts.postcode")}
                  value={postal.postcode}
                  maxLength={20}
                  onChange={(event) => change({ ...postal, postcode: event.target.value })}
                />
                <TextInput
                  aria-label={t("contacts.locality")}
                  placeholder={t("contacts.locality")}
                  value={postal.locality}
                  maxLength={100}
                  onChange={(event) => change({ ...postal, locality: event.target.value })}
                />
                <span className="col-span-2">
                  <TextInput
                    aria-label={t("contacts.country")}
                    placeholder={t("contacts.country")}
                    value={postal.country}
                    maxLength={100}
                    onChange={(event) => change({ ...postal, country: event.target.value })}
                  />
                </span>
              </div>
            )}
          />

          <Field
            label={t("contacts.birthday")}
            hint={
              yearless && form.birthday
                ? t("contacts.birthdayWithoutYear", { date: formatBirthday(form.birthday, i18n.language) })
                : undefined
            }
          >
            {(id) => (
              <span className="flex max-w-60 gap-2">
                <TextInput
                  id={id}
                  type="date"
                  value={yearless ? "" : (form.birthday ?? "")}
                  onChange={(event) => setForm({ birthday: event.target.value || null, birthdayChanged: true })}
                />
                {form.birthday && (
                  <IconButton
                    icon={X}
                    size="sm"
                    label={t("contacts.clearBirthday")}
                    onClick={() => setForm({ birthday: null, birthdayChanged: true })}
                    className="self-center"
                  />
                )}
              </span>
            )}
          </Field>

          {books.length > 1 && (
            <Field label={t("contacts.addressBook")}>
              {(id) => (
                <Select id={id} value={bookId} onChange={(event) => setForm({ addressBookId: event.target.value })}>
                  {books.map((book) => (
                    <option key={book.id} value={book.id}>
                      {bookLabel(book)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          <Field label={t("contacts.note")}>
            {(id) => (
              <textarea
                id={id}
                value={form.note}
                rows={3}
                maxLength={10000}
                onChange={(event) => setForm({ note: event.target.value })}
                className="w-full resize-y rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-faint focus:border-pink focus:shadow-focus focus:outline-none"
              />
            )}
          </Field>

          <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
            {contact && (
              <Button
                variant="danger"
                icon={Trash}
                onClick={() => {
                  onClose();
                  useContactsUi.getState().askDelete(contact);
                }}
              >
                {t("contacts.delete")}
              </Button>
            )}
            <span className="flex-1" />
            <Button variant="ghost" onClick={requestClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!bookId}>
              {t("common.save")}
            </Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDiscardDialog
        open={asking}
        onKeepEditing={() => setAsking(false)}
        onDiscard={() => {
          setAsking(false);
          onClose();
        }}
      />
    </>
  );
}

function KindSelect({ kinds, value, onChange }: { kinds: string[]; value: string; onChange: (kind: string) => void }) {
  const { t } = useT();
  return (
    <span className="w-32 shrink-0">
      <Select aria-label={t("contacts.kind")} value={value} onChange={(event) => onChange(event.target.value)}>
        {kinds.map((kind) => (
          <option key={kind} value={kind}>
            {t(`contacts.kinds.${kind}`)}
          </option>
        ))}
      </Select>
    </span>
  );
}

/** A list of entries that can grow and shrink: emails, numbers, addresses. */
function Rows<T>({
  legend,
  addLabel,
  items,
  onChange,
  blank,
  render,
}: {
  legend: string;
  addLabel: string;
  items: T[];
  onChange: (items: T[]) => void;
  blank: () => T;
  render: (item: T, change: (item: T) => void) => ReactNode;
}) {
  const { t } = useT();
  const ref = useRef<HTMLFieldSetElement>(null);
  const [added, setAdded] = useState(0);
  // A new entry gets the cursor, so typing goes right into it.
  useEffect(() => {
    if (added === 0) return;
    const rows = ref.current?.querySelectorAll<HTMLElement>("[data-entry]");
    rows?.[rows.length - 1]?.querySelector<HTMLInputElement>("input")?.focus();
  }, [added]);
  return (
    <fieldset ref={ref} className="flex flex-col gap-2">
      <legend className="mb-1.5 text-[13px] font-semibold text-muted">{legend}</legend>
      {items.map((item, index) => (
        <div key={index} data-entry className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 gap-2">
            {render(item, (changed) => onChange(items.map((old, i) => (i === index ? changed : old))))}
          </div>
          <IconButton
            icon={X}
            size="sm"
            label={t("contacts.removeEntry")}
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            className="mt-1.5"
          />
        </div>
      ))}
      <Button
        variant="ghost"
        size="sm"
        icon={Plus}
        onClick={() => {
          onChange([...items, blank()]);
          setAdded((count) => count + 1);
        }}
        className="self-start"
      >
        {addLabel}
      </Button>
    </fieldset>
  );
}
