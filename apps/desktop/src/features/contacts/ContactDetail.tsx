import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { BookUser, Cake, ChevronLeft, Mail, MapPin, NotebookPen, Pencil, Phone, Trash } from "lucide-react";
import type { ReactNode } from "react";
import type { ContactRecord } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n";
import { useUi } from "@/state/ui";
import { ContactAvatar } from "./ContactAvatar";
import { addressLines, formatBirthday } from "./format";
import { useContactsUi } from "./state";
import { useAddressBooks, useContacts } from "./useContactsData";

/** Writes to an address of a contact. */
export function writeTo(contact: ContactRecord, email: string) {
  useUi.getState().openCompose({ mode: "new", to: [{ name: contact.displayName || undefined, email }] });
}

function Row({
  icon: Icon,
  label,
  kind,
  children,
}: {
  icon: LucideIcon;
  label: string;
  kind?: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3 rounded-2xl px-3 py-2.5 hover:bg-canvas">
      <Icon className="mt-0.5 size-[18px] shrink-0 text-muted" strokeWidth={2} aria-label={label} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="selectable min-w-0 text-[14px] break-words">{children}</div>
        {kind && <span className="text-[12px] text-muted">{kind}</span>}
      </div>
    </li>
  );
}

/** One contact with everything it has, and what to do with it. */
/** One contact. `backWide` keeps the back button where the list is beside it too (phones). */
export function ContactDetail({
  className,
  onBack,
  backWide = false,
}: {
  className?: string;
  onBack?: () => void;
  backWide?: boolean;
}) {
  const { t, i18n } = useT();
  const selectedId = useContactsUi((s) => s.selectedId);
  const { data: contacts = [] } = useContacts();
  const { data: books = [] } = useAddressBooks();
  const contact = contacts.find((entry) => entry.id === selectedId) ?? null;

  if (!contact) {
    return (
      <section className={clsx("flex items-center justify-center bg-surface", className)}>
        <EmptyState scene="pick" title={t("contacts.pick")} />
      </section>
    );
  }

  const book = books.find((entry) => entry.id === contact.addressBookId);
  const subtitle = [contact.title, contact.organization !== contact.displayName ? contact.organization : ""]
    .filter(Boolean)
    .join(" · ");
  const firstEmail = contact.emails[0]?.address;
  const { openEditor, askDelete } = useContactsUi.getState();
  // Address books shared read-only (over CardDAV) are only shown.
  const writable = book?.mayWrite !== false;

  return (
    <section
      className={clsx("flex min-h-0 flex-col overflow-hidden bg-surface", className)}
      aria-label={contact.displayName}
    >
      <header className="flex items-center gap-1 px-3 pt-3">
        {onBack && (
          <IconButton
            icon={ChevronLeft}
            label={t("contacts.back")}
            onClick={onBack}
            className={backWide ? undefined : "lg:hidden"}
          />
        )}
        <span className="flex-1" />
        {writable && !contact.isGroup && (
          <IconButton icon={Pencil} label={t("contacts.edit")} onClick={() => openEditor({ contact })} />
        )}
        {writable && <IconButton icon={Trash} label={t("contacts.delete")} onClick={() => askDelete(contact)} />}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-8">
        <div className="flex flex-col items-center gap-3 pt-2 pb-5 text-center">
          <ContactAvatar contact={contact} size="lg" />
          <div className="min-w-0">
            <h1 className="selectable text-[22px] leading-tight font-extrabold break-words">
              {contact.displayName || t("contacts.nameless")}
            </h1>
            {subtitle && <p className="selectable text-[14px] text-muted">{subtitle}</p>}
          </div>
          {firstEmail && (
            <Button variant="primary" size="sm" icon={Mail} onClick={() => writeTo(contact, firstEmail)}>
              {t("contacts.writeMail")}
            </Button>
          )}
        </div>

        <ul className="mx-auto flex max-w-[560px] flex-col gap-0.5">
          {contact.emails.map((email) => (
            <Row key={`e-${email.id}`} icon={Mail} label={t("contacts.email")} kind={t(`contacts.kinds.${email.kind}`)}>
              <button
                type="button"
                onClick={() => writeTo(contact, email.address)}
                className="text-left break-all text-pink-ink hover:underline"
              >
                {email.address}
              </button>
            </Row>
          ))}
          {contact.phones.map((phone) => (
            <Row
              key={`p-${phone.id}`}
              icon={Phone}
              label={t("contacts.phone")}
              kind={t(`contacts.kinds.${phone.kind}`)}
            >
              <a href={`tel:${phone.number.replace(/[^\d+]/g, "")}`} className="text-pink-ink hover:underline">
                {phone.number}
              </a>
            </Row>
          ))}
          {contact.addresses.map((postal) => (
            <Row
              key={`a-${postal.id}`}
              icon={MapPin}
              label={t("contacts.address")}
              kind={t(`contacts.kinds.${postal.kind}`)}
            >
              {addressLines(postal).map((line, index) => (
                <span key={index} className="block">
                  {line}
                </span>
              ))}
            </Row>
          ))}
          {contact.birthday && (
            <Row icon={Cake} label={t("contacts.birthday")} kind={t("contacts.birthday")}>
              {formatBirthday(contact.birthday, i18n.language)}
            </Row>
          )}
          {contact.note && (
            <Row icon={NotebookPen} label={t("contacts.note")}>
              <span className="whitespace-pre-wrap">{contact.note}</span>
            </Row>
          )}
          {book && books.length > 1 && (
            <Row icon={BookUser} label={t("contacts.addressBook")} kind={t("contacts.addressBook")}>
              {book.name}
            </Row>
          )}
        </ul>
        {contact.isGroup && <p className="mt-4 text-center text-[13px] text-muted">{t("contacts.groupReadOnly")}</p>}
        {!writable && <p className="mt-4 text-center text-[13px] text-muted">{t("contacts.bookReadOnly")}</p>}
      </div>
    </section>
  );
}
