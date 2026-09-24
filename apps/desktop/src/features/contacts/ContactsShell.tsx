import clsx from "clsx";
import { Menu, UserPlus } from "lucide-react";
import { useMemo } from "react";
import type { ContactRecord } from "@/backend/types";
import { IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { useBackLayer } from "@/lib/backStack";
import { useIsPhone, useMediaQuery } from "@/lib/device";
import { useHotkeys, type HotkeyMap } from "@/lib/hotkeys";
import { useUi } from "@/state/ui";
import { useCalendarsAvailable } from "../calendar/useCalendarData";
import { ContactDetail } from "./ContactDetail";
import { CONTACT_SEARCH_ID, ContactList, useVisibleContacts } from "./ContactList";
import { ContactsSidebar } from "./ContactsSidebar";
import { startNewContact, useContactsUi } from "./state";
import { useAddressBooks, useContacts } from "./useContactsData";

/** Wide enough for the sidebar beside the list and the contact. */
const ROOM_FOR_SIDEBAR = "(min-width: 1100px)";

/** Keys like the mail's: j/k to move, c for a new contact, e to edit, # to delete, / to search. */
function useContactHotkeys(contacts: ContactRecord[], calendar: boolean) {
  const map = useMemo<HotkeyMap>(() => {
    const ui = () => useContactsUi.getState();
    const ids = contacts.map((contact) => contact.id);
    const selected = () => contacts.find((contact) => contact.id === ui().selectedId);
    const remove = () => {
      const contact = selected();
      if (contact) ui().askDelete(contact);
    };
    const step = (delta: number) => {
      const current = ids.indexOf(ui().selectedId ?? "");
      const next = ids[Math.max(0, Math.min(ids.length - 1, current < 0 ? 0 : current + delta))];
      if (next) ui().select(next);
    };
    return {
      j: () => step(1),
      k: () => step(-1),
      ArrowDown: () => step(1),
      ArrowUp: () => step(-1),
      c: () => startNewContact(),
      e: () => {
        const contact = selected();
        if (contact && !contact.isGroup) ui().openEditor({ contact });
      },
      "#": remove,
      Delete: remove,
      "/": () => {
        document.getElementById(CONTACT_SEARCH_ID)?.focus();
      },
      "g m": () => useUi.getState().setSection("mail"),
      "g i": () => useUi.getState().setView({ kind: "unified", role: "inbox" }),
      "g c": () => {
        if (calendar) useUi.getState().setSection("calendar");
      },
      "mod+k": () => useUi.getState().setPaletteOpen(true),
      "mod+,": () => useUi.getState().openSettings(),
      "?": () => useUi.getState().setShortcutsOpen(true),
      Escape: () => {
        if (useUi.getState().folderDrawerOpen) useUi.getState().setFolderDrawerOpen(false);
        else ui().select(null);
      },
    };
  }, [contacts, calendar]);
  useHotkeys(map, { repeat: ["j", "k", "ArrowDown", "ArrowUp"] });
}

/** The contacts, where the mail list and reader would be. Phones get the list, then one contact. */
export function ContactsShell() {
  const phone = useIsPhone();
  const { contacts } = useVisibleContacts();
  const { data: calendar = false } = useCalendarsAvailable();
  useContactHotkeys(contacts, calendar);
  // Loaded here too, so the counts and the editor's choice are there right away.
  useAddressBooks();
  useContacts();
  return phone ? <PhoneContacts /> : <DesktopContacts />;
}

function ListHeader({ onMenu }: { onMenu?: () => void }) {
  const { t } = useT();
  const bookId = useContactsUi((s) => s.bookId);
  const { data: books = [] } = useAddressBooks();
  const title = books.find((book) => book.id === bookId)?.name ?? t("contacts.all");
  return (
    <div className="flex items-center gap-1">
      {onMenu && <IconButton icon={Menu} label={t("contacts.menu")} onClick={onMenu} className="-ml-1" />}
      <h1 className="min-w-0 flex-1 truncate text-[20px] leading-tight font-extrabold tracking-[-0.01em]">{title}</h1>
      {onMenu && <IconButton icon={UserPlus} label={t("contacts.newContact")} onClick={() => startNewContact()} />}
    </div>
  );
}

function DesktopContacts() {
  const { t } = useT();
  const room = useMediaQuery(ROOM_FOR_SIDEBAR);
  const drawerOpen = useUi((s) => s.folderDrawerOpen);
  const setDrawerOpen = useUi((s) => s.setFolderDrawerOpen);
  const selectedId = useContactsUi((s) => s.selectedId);

  return (
    <div className="relative flex min-h-0 flex-1 gap-3 p-3">
      {room && <ContactsSidebar className="min-h-0 w-[240px] shrink-0 rounded-[22px] border border-hairline" />}
      <ContactList
        header={<ListHeader onMenu={room ? undefined : () => setDrawerOpen(true)} />}
        className={clsx(
          "rounded-[22px] border border-hairline",
          selectedId ? "hidden w-[340px] shrink-0 lg:flex" : "w-full max-w-[420px] shrink-0 max-lg:max-w-none",
        )}
      />
      <ContactDetail
        className={clsx("min-w-0 flex-1 rounded-[22px] border border-hairline", !selectedId && "max-lg:hidden")}
        onBack={() => useContactsUi.getState().select(null)}
      />

      {drawerOpen && !room && (
        <div className="absolute inset-0 z-30 flex" role="presentation">
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 animate-fade bg-[#1c1420]/30"
          />
          <ContactsSidebar
            className="relative w-[280px] animate-slide-up rounded-r-[22px] bg-surface shadow-float"
            onNavigate={() => setDrawerOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

function PhoneContacts() {
  const { t } = useT();
  const selectedId = useContactsUi((s) => s.selectedId);
  const drawerOpen = useUi((s) => s.folderDrawerOpen);
  const setDrawerOpen = useUi((s) => s.setFolderDrawerOpen);
  useBackLayer(drawerOpen, () => setDrawerOpen(false));
  useBackLayer(selectedId !== null, () => useContactsUi.getState().select(null));

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface">
      {selectedId ? (
        <ContactDetail className="h-full" backWide onBack={() => useContactsUi.getState().select(null)} />
      ) : (
        <ContactList className="h-full" header={<ListHeader onMenu={() => setDrawerOpen(true)} />} />
      )}
      {drawerOpen && (
        <div className="fixed inset-0 z-30" role="presentation">
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 animate-fade bg-[#1c1420]/40"
          />
          <div className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] animate-[uwu-drawer_220ms_cubic-bezier(0.2,0.9,0.3,1)] overflow-hidden rounded-r-[24px] bg-surface shadow-float">
            <ContactsSidebar className="h-full pt-3" onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
