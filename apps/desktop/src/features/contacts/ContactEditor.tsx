import { Button, Field, IconButton, ICONS, Select, TextInput } from "@uwusuite/design";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ContactEmail,
  ContactInput,
  ContactKind,
  ContactPhone,
  ContactPostal,
  ContactRecord,
} from "@/backend/types";
import { ConfirmDiscardDialog } from "@/components/ui/ConfirmDiscardDialog";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { useAccounts } from "@/lib/queries";
import { useBirthdayFeatures } from "../calendar/BirthdayImport";
import { ContactPictureField } from "./ContactPicture";
import { DayField, RemindersField } from "./DateFields";
import { hasName, inputFrom } from "./format";
import { useContactsUi, type ContactEditorRequest } from "./state";
import { useAddressBooks, useContactActions } from "./useContactsData";
import { useContactPhoto } from "./useContactPhoto";

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
  const { t } = useT();
  const { data: allBooks = [] } = useAddressBooks();
  const { data: birthdayFeatures = [] } = useBirthdayFeatures();
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
  // Fields that give a day that doesn't exist (31 April): saving waits until they're fixed.
  const [badDays, setBadDays] = useState<{ birthday?: boolean; anniversary?: boolean }>({});
  const actions = useContactActions();
  const storedPhoto = useContactPhoto(request?.contact ?? null, true);
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
  const photo = form.photo !== undefined ? form.photo : storedPhoto;
  const firstEmail = form.emails.find((email) => email.address.includes("@"))?.address.trim() ?? null;

  const save = async () => {
    setTried(true);
    if (nameless || !bookId || badDays.birthday || badDays.anniversary) return;
    setBusy(true);
    const input = { ...form, addressBookId: bookId };
    const saved = contact ? await actions.update(contact, input) : await actions.create(input);
    setBusy(false);
    if (saved) onClose();
  };

  const reminders = form.reminders ?? contact?.reminders ?? [];
  // Reminders ring from a UwUMail server's birthdays calendar; other mailboxes have none to ring them.
  const accountId = contact?.accountId ?? books.find((book) => book.id === bookId)?.accountId;
  const remindable = birthdayFeatures.some((features) => features.accountId === accountId && features.server);

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
          <ContactPictureField
            photo={photo}
            src={photo}
            email={firstEmail}
            onChange={(next) => setForm({ photo: next })}
          />

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
            <p role="alert" className="-mt-2 text-[13px] text-danger-ink">
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

          <DayField
            label={t("contacts.birthday")}
            clearLabel={t("contacts.clearBirthday")}
            kind="birth"
            value={form.birthday}
            onChange={(birthday, valid) => {
              setBadDays((bad) => ({ ...bad, birthday: !valid }));
              setForm({ birthday, birthdayChanged: true });
            }}
          />
          <DayField
            label={t("contacts.anniversary")}
            clearLabel={t("contacts.clearAnniversary")}
            kind="wedding"
            value={form.anniversary ?? null}
            onChange={(anniversary, valid) => {
              setBadDays((bad) => ({ ...bad, anniversary: !valid }));
              setForm({ anniversary, anniversaryChanged: true });
            }}
          />
          {remindable && (form.birthday || form.anniversary || reminders.length > 0) && (
            <RemindersField value={reminders} onChange={(next) => setForm({ reminders: next })} />
          )}

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
                icon={ICONS.delete}
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
            icon={ICONS.close}
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
        icon={ICONS.add}
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
