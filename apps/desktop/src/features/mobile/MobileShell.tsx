import {
  currentDeviceKind,
  GroupedList,
  ICONS,
  ListRow,
  ListSection,
  MobileShell as Shell,
  NavButton,
  SearchBar,
  Sheet,
  TabBar,
  type MobilePlatform,
  type TabItem,
} from "@uwusuite/design";
import { useEffect, useState } from "react";
import type { MailboxView } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { MobileToaster } from "@/components/ui/Toaster";
import { useT } from "@/i18n";
import { accountLabel } from "@/lib/accountLabel";
import { useBackLayer } from "@/lib/backStack";
import { isAndroid } from "@/lib/device";
import { useFolders, useVisibleAccounts } from "@/lib/queries";
import { useUi, type AppSection } from "@/state/ui";
import { loadLocalDraft } from "../compose/localDraft";
import { reopenSavedDraft } from "../compose/openDraft";
import { LazyCalendar } from "../shell/LazyCalendar";
import { LazyContacts } from "../shell/LazyContacts";
import { SECTIONS, useAvailableSections } from "../shell/AppSwitch";
import { MobileList } from "./MobileList";
import { MobileMailboxes } from "./MobileMailboxes";
import { MobileReader } from "./MobileReader";
import { MobileSettings } from "./MobileSettings";

type Tab = AppSection | "settings";

const platform: MobilePlatform = isAndroid ? "android" : "ios";
// In a desktop browser (development, the demo) the package would see no phone: pin it then.
// On a real phone the shell detects it itself and follows the keyboard.
const pinnedKind = currentDeviceKind() === "desktop" ? (isAndroid ? "phone-android" : "phone-ios") : undefined;

/** The account avatar: top left on the iPhone, at the end of the search bar on Android. */
function AccountButton({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  const { accounts } = useVisibleAccounts();
  const first = accounts[0];
  return (
    <NavButton label={t("nav.accounts")} platform={platform} onClick={onClick} className="overflow-hidden p-0!">
      {first ? <Avatar address={{ name: first.displayName || first.name, email: first.email }} size="sm" /> : undefined}
    </NavButton>
  );
}

/** The account switcher behind the avatar: each mailbox's inbox, and a new one. */
function AccountSheet({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (view: MailboxView) => void;
}) {
  const { t } = useT();
  const { accounts } = useVisibleAccounts();
  const { data: folders = [] } = useFolders();
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);
  const openSettings = useUi((s) => s.openSettings);
  return (
    <Sheet open={open} onClose={onClose} title={t("nav.accounts")} detents={["medium", "large"]} platform={platform}>
      <GroupedList platform={platform}>
        <ListSection>
          {accounts
            .filter((account) => !account.parentId)
            .map((account) => {
              const inbox = folders.find((f) => f.accountId === account.id && f.role === "inbox");
              return (
                <ListRow
                  key={account.id}
                  icon={
                    <Avatar address={{ name: account.displayName || account.name, email: account.email }} size="sm" />
                  }
                  title={accountLabel(account)}
                  subtitle={account.email !== accountLabel(account) ? account.email : undefined}
                  disabled={!inbox}
                  onClick={() => {
                    onClose();
                    if (inbox) onOpen({ kind: "folder", accountId: account.id, folderId: inbox.id });
                  }}
                />
              );
            })}
        </ListSection>
        <ListSection>
          <ListRow
            icon={ICONS.account}
            iconTone="neutral"
            title={t("settings.accounts")}
            onClick={() => {
              onClose();
              openSettings("accounts");
            }}
          />
          <ListRow
            tone="accent"
            title={t("nav.addAccount")}
            onClick={() => {
              onClose();
              setAddAccountOpen(true);
            }}
          />
        </ListSection>
      </GroupedList>
    </Sheet>
  );
}

/**
 * UwUMail on a phone: tabs for mail, calendar, contacts and the settings. The mail tab starts with
 * the mailbox overview and pushes the list and the conversation on top of it; there is no drawer.
 */
export function MobileShell() {
  const { t } = useT();
  const section = useUi((s) => s.section);
  const setSection = useUi((s) => s.setSection);
  const setView = useUi((s) => s.setView);
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const selectThread = useUi((s) => s.selectThread);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const closeSettings = useUi((s) => s.closeSettings);
  const addAccountOpen = useUi((s) => s.addAccountOpen);
  const available = useAvailableSections();
  const [onSettingsTab, setOnSettingsTab] = useState(false);
  // Opens on the inbox, with the overview one step back.
  const [listOpen, setListOpen] = useState(true);
  const [searching, setSearching] = useState(false);
  const [draft, setDraft] = useState(search);
  const [accountsOpen, setAccountsOpen] = useState(false);

  const tab: Tab = settingsOpen !== null || onSettingsTab ? "settings" : section;

  useBackLayer(selectedThreadId !== null, () => selectThread(null));
  useBackLayer(addAccountOpen, () => useUi.getState().setAddAccountOpen(false));
  useBackLayer(tab === "mail" && listOpen && selectedThreadId === null && !searching, () => setListOpen(false));

  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft), 180);
    return () => clearTimeout(timer);
  }, [draft, setSearch]);

  // A draft Android didn't let us finish comes back as the bar above the write button.
  useEffect(() => {
    const saved = loadLocalDraft();
    const ui = useUi.getState();
    if (!saved || ui.compose) return;
    if (saved.messageId) {
      // Only its id was kept: the draft itself comes back from the Drafts folder.
      void reopenSavedDraft(saved.messageId);
      return;
    }
    ui.openCompose({ mode: saved.mode, restore: saved });
    ui.setComposeMinimized(true);
  }, []);

  const tabs: TabItem<Tab>[] = [
    ...SECTIONS.filter(({ id }) => available.includes(id)).map(({ id, icon }) => ({
      id: id as Tab,
      icon,
      label: t(`nav.section.${id}`),
    })),
    { id: "settings", icon: ICONS.settings, label: t("nav.settings") },
  ];
  const changeTab = (next: Tab) => {
    if (next === "settings") {
      setOnSettingsTab(true);
      return;
    }
    setOnSettingsTab(false);
    if (settingsOpen !== null) closeSettings();
    // Tapping the mail tab again goes back to the overview.
    if (next === "mail" && tab === "mail") setListOpen(false);
    setSection(next);
  };
  const openView = (view: MailboxView) => {
    setView(view);
    setOnSettingsTab(false);
    if (settingsOpen !== null) closeSettings();
    setSection("mail");
    setListOpen(true);
  };
  const startSearch = (open: boolean) => {
    setSearching(open);
    if (open) {
      setListOpen(true);
    } else {
      setDraft("");
    }
  };

  const avatar = <AccountButton onClick={() => setAccountsOpen(true)} />;
  const androidSearch =
    platform === "android" ? (
      <SearchBar value={draft} onChange={setDraft} placeholder={t("list.search")} trailing={avatar} />
    ) : undefined;

  return (
    <Shell kind={pinnedKind} className="h-full">
      {tab === "settings" ? (
        <MobileSettings platform={platform} />
      ) : tab === "calendar" ? (
        <LazyCalendar />
      ) : tab === "contacts" ? (
        <LazyContacts />
      ) : (
        <>
          {listOpen ? (
            <MobileList platform={platform} onBack={() => setListOpen(false)} searchBar={androidSearch} />
          ) : (
            <MobileMailboxes
              platform={platform}
              leading={platform === "ios" ? avatar : undefined}
              trailing={
                platform === "ios" ? (
                  <NavButton
                    icon={ICONS.compose}
                    label={t("nav.compose")}
                    platform={platform}
                    onClick={() => useUi.getState().openCompose({ mode: "new" })}
                  />
                ) : undefined
              }
              onOpen={openView}
            />
          )}
          {selectedThreadId && (
            <div className="absolute inset-0 z-30 animate-[uwu-screen-in_220ms_cubic-bezier(0.2,0.9,0.3,1)]">
              <MobileReader key={selectedThreadId} threadId={selectedThreadId} />
            </div>
          )}
        </>
      )}

      {!selectedThreadId && (
        <TabBar
          tabs={tabs}
          value={tab}
          onChange={changeTab}
          platform={platform}
          label={t("nav.apps")}
          search={
            tab === "mail"
              ? {
                  open: searching,
                  onOpenChange: startSearch,
                  value: draft,
                  onChange: setDraft,
                  placeholder: t("list.search"),
                }
              : undefined
          }
        />
      )}
      <AccountSheet open={accountsOpen} onClose={() => setAccountsOpen(false)} onOpen={openView} />
      <MobileToaster platform={platform} />
    </Shell>
  );
}
