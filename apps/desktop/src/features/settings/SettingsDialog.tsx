import clsx from "clsx";
import {
  BellOff,
  ExternalLink,
  ImageIcon,
  Info,
  Keyboard,
  Lock,
  Mail,
  Palette,
  PenLine,
  Plus,
  Puzzle,
  Upload,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import pkg from "../../../package.json";
import { backend } from "@/backend/backend";
import { mobile, nativeAndroid } from "@/backend/mobile";
import type { Account, Protocol } from "@/backend/types";
import { AccountDot } from "@/components/ui/Avatar";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented, Select, Toggle } from "@/components/ui/Field";
import { LogoSymbol } from "@/components/ui/Logo";
import { i18n, useT } from "@/i18n";
import { useIsPhone } from "@/lib/device";
import { openLinkNow } from "@/state/links";
import { useAccounts } from "@/lib/queries";
import { isDomainEntry, sortEntries } from "@/lib/trustedSenders";
import { workspaceOf } from "@/lib/workspaces";
import { confirmIdentity } from "@/state/lock";
import {
  useSettings,
  type LanguageSetting,
  type LockAfter,
  type OfflineDays,
  type SwipeAction,
} from "@/state/settings";
import { toast } from "@/state/toasts";
import { BlockedSenders } from "./BlockedSenders";
import { Row } from "./Row";
import { Writing } from "./Writing";
import { useUi, type SettingsSection } from "@/state/ui";
import { WorkspacePicker, WorkspaceSettings } from "../workspaces/WorkspaceSettings";

const PROTOCOL_NAMES: Record<Protocol, string> = { imap: "IMAP", jmap: "JMAP" };

const SECTIONS: { id: SettingsSection; icon: LucideIcon; androidOnly?: boolean }[] = [
  { id: "appearance", icon: Palette },
  { id: "mail", icon: Mail },
  { id: "compose", icon: PenLine },
  { id: "security", icon: Lock, androidOnly: true },
  { id: "accounts", icon: Users },
  { id: "addons", icon: Puzzle },
  { id: "about", icon: Info },
];

function Appearance() {
  const { t } = useT();
  const settings = useSettings();
  return (
    <>
      <Row label={t("settings.layout")} description={t(`layout.${settings.layout}.desc`)}>
        <Segmented
          label={t("settings.layout")}
          value={settings.layout}
          onChange={(layout) => settings.update({ layout })}
          options={[
            { value: "simple", label: t("layout.simple.name") },
            { value: "pro", label: t("layout.pro.name") },
          ]}
        />
      </Row>
      <Row label={t("settings.listDensity")} description={t("settings.listDensityDesc")}>
        <Segmented
          label={t("settings.listDensity")}
          value={settings.listDensity}
          onChange={(listDensity) => settings.update({ listDensity })}
          options={[
            { value: "relaxed", label: t("density.relaxed") },
            { value: "compact", label: t("density.compact") },
          ]}
        />
      </Row>
      <Row label={t("settings.theme")}>
        <Segmented
          label={t("settings.theme")}
          value={settings.theme}
          onChange={(theme) => settings.update({ theme })}
          options={[
            { value: "system", label: t("theme.system") },
            { value: "light", label: t("theme.light") },
            { value: "dark", label: t("theme.dark") },
          ]}
        />
      </Row>
      <Row label={t("settings.motion")} description={t("settings.motionDesc")}>
        <Segmented
          label={t("settings.motion")}
          value={settings.motion}
          onChange={(motion) => settings.update({ motion })}
          options={[
            { value: "system", label: t("motion.system") },
            { value: "on", label: t("motion.on") },
            { value: "off", label: t("motion.off") },
          ]}
        />
      </Row>
      <Row
        label={t("settings.tone")}
        description={t("tone.sample", { text: i18n.getFixedT(null, settings.tone)("toast.sent") })}
      >
        <Segmented
          label={t("settings.tone")}
          value={settings.tone}
          onChange={(tone) => settings.update({ tone })}
          options={[
            { value: "playful", label: t("tone.playful.name") },
            { value: "neutral", label: t("tone.neutral.name") },
          ]}
        />
      </Row>
      <Row label={t("settings.language")}>
        <Select
          aria-label={t("settings.language")}
          value={settings.language}
          onChange={(event) => settings.update({ language: event.target.value as LanguageSetting })}
          className="max-w-[240px]"
        >
          <option value="system">{t("language.system")}</option>
          <option value="de">{t("language.de")}</option>
          <option value="en">{t("language.en")}</option>
        </Select>
      </Row>
    </>
  );
}

function TrustedSenders() {
  const { t } = useT();
  const trusted = useSettings((s) => s.trustedSenders);
  const remoteImages = useSettings((s) => s.remoteImages);
  const untrustSenders = useSettings((s) => s.untrustSenders);
  const entries = sortEntries(trusted);

  return (
    <Row label={t("settings.trustedSenders")} description={t("settings.trustedSendersDesc")}>
      {remoteImages === "always" && entries.length > 0 && (
        <p className="text-[12.5px] text-warning">{t("settings.trustedSendersInactive")}</p>
      )}
      {entries.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
          {t("settings.trustedSendersEmpty")}
        </p>
      ) : (
        <ul
          className={clsx(
            "flex max-h-56 flex-col overflow-y-auto rounded-2xl border border-hairline p-1",
            remoteImages === "always" && "opacity-60",
          )}
        >
          {entries.map((entry) => (
            <li key={entry} className="flex items-center gap-3 rounded-xl py-1 pr-1 pl-3 hover:bg-elevated">
              <ImageIcon className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="selectable min-w-0 flex-1 truncate text-[13.5px]">
                {isDomainEntry(entry) ? (
                  <>
                    <span className="text-muted">@</span>
                    <span className="font-semibold">{entry.slice(1)}</span>
                  </>
                ) : (
                  entry
                )}
              </span>
              <IconButton
                icon={X}
                size="sm"
                label={t("settings.untrustSender", { sender: entry })}
                onClick={() => untrustSenders([entry])}
              />
            </li>
          ))}
        </ul>
      )}
    </Row>
  );
}

const SWIPE_ACTIONS: SwipeAction[] = ["read", "archive", "trash", "flag", "none"];

function SwipeSelect({ value, onChange }: { value: SwipeAction; onChange: (value: SwipeAction) => void }) {
  const { t } = useT();
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value as SwipeAction)} className="max-w-[240px]">
      {SWIPE_ACTIONS.map((action) => (
        <option key={action} value={action}>
          {t(`mobile.swipe.${action}`)}
        </option>
      ))}
    </Select>
  );
}

const LOCK_AFTER: LockAfter[] = [0, 1, 5, 15];

function Security() {
  const { t } = useT();
  const appLock = useSettings((s) => s.appLock);
  const appLockAfter = useSettings((s) => s.appLockAfter);
  const update = useSettings((s) => s.update);
  return (
    <>
      <div className="border-b border-hairline py-4">
        <Toggle
          checked={appLock}
          onChange={async (enabled) => {
            if (enabled && !(await mobile.canLock())) return toast(t("settings.appLockUnavailable"), "error");
            // Turning it on proves the phone can unlock; turning it off needs the same proof as getting past it.
            if (await confirmIdentity(t("mobile.lock.reason"), t("mobile.lock.prompt"))) update({ appLock: enabled });
          }}
          label={t("settings.appLock")}
          description={t("settings.appLockDesc")}
        />
      </div>
      {appLock && (
        <Row label={t("settings.appLockAfter")}>
          <Segmented
            label={t("settings.appLockAfter")}
            value={String(appLockAfter)}
            onChange={async (value) => {
              const minutes = Number(value) as LockAfter;
              // A longer wait weakens the lock, so it's confirmed like turning it off.
              if (
                minutes > appLockAfter &&
                !(await confirmIdentity(t("mobile.lock.reason"), t("mobile.lock.prompt")))
              ) {
                return;
              }
              update({ appLockAfter: minutes });
            }}
            options={LOCK_AFTER.map((minutes) => ({
              value: String(minutes),
              label: minutes === 0 ? t("settings.lockNow") : t("settings.lockMinutes", { count: minutes }),
            }))}
          />
        </Row>
      )}
    </>
  );
}

function Reading() {
  const { t } = useT();
  const settings = useSettings();
  const phone = useIsPhone();
  const client = useQueryClient();
  return (
    <>
      <div className="border-b border-hairline py-4">
        <Toggle
          checked={settings.conversations}
          onChange={(conversations) => settings.update({ conversations })}
          label={t("settings.conversations")}
          description={t("settings.conversationsDesc")}
        />
      </div>
      <Row label={t("settings.remoteImages")} description={t("settings.remoteImagesDesc")}>
        <Segmented
          label={t("settings.remoteImages")}
          value={settings.remoteImages}
          onChange={(remoteImages) => settings.update({ remoteImages })}
          options={[
            { value: "ask", label: t("settings.remoteAsk") },
            { value: "always", label: t("settings.remoteAlways") },
          ]}
        />
      </Row>
      <TrustedSenders />
      <BlockedSenders />
      <Row label={t("settings.mailAppearance")} description={t("settings.mailAppearanceDesc")}>
        <Segmented
          label={t("settings.mailAppearance")}
          value={settings.mailAppearance}
          onChange={(mailAppearance) => settings.update({ mailAppearance })}
          options={[
            { value: "auto", label: t("settings.mailAppearanceAuto") },
            { value: "light", label: t("settings.mailAppearanceLight") },
            { value: "dark", label: t("settings.mailAppearanceDark") },
          ]}
        />
        {Object.keys(settings.senderAppearance).length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => {
              settings.forgetAppearances();
              toast(t("settings.appearancesForgotten"), "success");
            }}
          >
            {t("settings.forgetAppearances", { count: Object.keys(settings.senderAppearance).length })}
          </Button>
        )}
      </Row>
      <div className="flex flex-col gap-2 border-b border-hairline py-4">
        <Toggle
          checked={settings.senderPictures}
          onChange={(senderPictures) => settings.update({ senderPictures })}
          label={t("settings.senderPictures")}
          description={t("settings.senderPicturesDesc")}
        />
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => {
            void backend()
              .clearSenderPictures()
              .then(() => {
                client.removeQueries({ queryKey: ["senderPicture"] });
                toast(t("settings.senderPicturesCleared"), "success");
              });
          }}
        >
          {t("settings.clearSenderPictures")}
        </Button>
      </div>
      {phone && (
        <Row label={t("settings.swipeRight")} description={t("settings.swipeDesc")}>
          <SwipeSelect value={settings.swipeRight} onChange={(swipeRight) => settings.update({ swipeRight })} />
          <p className="pt-1 text-sm font-semibold">{t("settings.swipeLeft")}</p>
          <SwipeSelect value={settings.swipeLeft} onChange={(swipeLeft) => settings.update({ swipeLeft })} />
        </Row>
      )}
      {nativeAndroid && (
        <Row label={t("settings.offlineDays")} description={t("settings.offlineDaysDesc")}>
          <Segmented
            label={t("settings.offlineDays")}
            value={String(settings.offlineDays)}
            onChange={(value) => settings.update({ offlineDays: Number(value) as OfflineDays })}
            options={[
              { value: "30", label: t("settings.offlineDays30") },
              { value: "90", label: t("settings.offlineDays90") },
              { value: "365", label: t("settings.offlineDaysYear") },
              { value: "0", label: t("settings.offlineDaysAll") },
            ]}
          />
        </Row>
      )}
      <div className="flex flex-col gap-2 border-b border-hairline py-4">
        <Toggle
          checked={settings.runInBackground}
          onChange={(runInBackground) => settings.update({ runInBackground })}
          label={t(nativeAndroid ? "settings.backgroundPush" : "settings.runInBackground")}
          description={t(nativeAndroid ? "settings.backgroundPushDesc" : "settings.runInBackgroundDesc")}
        />
        {nativeAndroid && settings.runInBackground && (
          <Button
            size="sm"
            variant="ghost"
            icon={BellOff}
            className="self-start"
            onClick={() => void mobile.openWatchSettings()}
          >
            {t("settings.hideWatchNotification")}
          </Button>
        )}
      </div>
    </>
  );
}

function Accounts() {
  const { t } = useT();
  const { data: accounts = [] } = useAccounts();
  const client = useQueryClient();
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);
  const workspaces = useSettings((s) => s.workspaces);
  const businessAccounts = useSettings((s) => s.businessAccounts);
  const setAccountWorkspace = useSettings((s) => s.setAccountWorkspace);
  const [switching, setSwitching] = useState<string | null>(null);

  const switchProtocol = async (account: Account, protocol: Protocol) => {
    const name = PROTOCOL_NAMES[protocol];
    if (!window.confirm(t("settings.protocolSwitchConfirm", { email: account.email, protocol: name }))) return;
    setSwitching(account.id);
    try {
      await backend().setAccountProtocol(account.id, protocol);
      await client.invalidateQueries();
      toast(t("settings.protocolSwitched", { email: account.email, protocol: name }), "success");
    } catch (reason) {
      toast(reason instanceof Error ? reason.message : String(reason), "error");
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 py-4">
      <WorkspaceSettings />
      <ul className="flex flex-col gap-2">
        {accounts.map((account) => {
          const other = account.protocols.find((p) => p !== account.protocol);
          return (
            <li
              key={account.id}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-hairline px-4 py-3"
            >
              <AccountDot color={account.color} className="size-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{account.email}</span>
                <span className="block text-[12.5px] text-muted">
                  {account.displayName} · {PROTOCOL_NAMES[account.protocol]}
                  {account.auth !== "password" && ` · ${account.auth === "microsoft" ? "Microsoft" : "Google"}`}
                </span>
              </span>
              {other && (
                <Button
                  size="sm"
                  variant="ghost"
                  busy={switching === account.id}
                  onClick={() => void switchProtocol(account, other)}
                >
                  {t("settings.protocolSwitchTo", { protocol: PROTOCOL_NAMES[other] })}
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (!window.confirm(t("settings.removeAccountConfirm", { email: account.email }))) return;
                  await backend().removeAccount(account.id);
                  setAccountWorkspace(account.id, "private");
                  await client.invalidateQueries();
                }}
              >
                {t("settings.removeAccount")}
              </Button>
              {workspaces && (
                <div className="flex basis-full items-center justify-between gap-3 border-t border-hairline pt-2.5">
                  <span className="text-[13px] font-semibold text-muted">{t("workspace.label")}</span>
                  <WorkspacePicker
                    label={t("workspace.of", { email: account.email })}
                    value={workspaceOf(account.id, businessAccounts)}
                    onChange={(workspace) => setAccountWorkspace(account.id, workspace)}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <Button icon={Plus} onClick={() => setAddAccountOpen(true)} className="self-start">
        {t("nav.addAccount")}
      </Button>
    </div>
  );
}

function Addons() {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center gap-2 py-4">
      <EmptyState
        scene="addons"
        compact
        title={t("settings.addonsEmptyTitle")}
        body={t("settings.addonsEmptyBody")}
        className="py-6"
      />
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" icon={Puzzle} disabled>
          {t("settings.addonsCatalog")}
        </Button>
        <Button icon={Upload} disabled>
          {t("settings.addonsFromFile")}
        </Button>
      </div>
      <p className="pt-2 text-[12.5px] text-muted">{t("settings.addonsSoon")}</p>
    </div>
  );
}

function UpdateSettings() {
  const { t } = useT();
  const channel = useSettings((s) => s.updateChannel);
  const update = useSettings((s) => s.update);
  const [checking, setChecking] = useState(false);

  return (
    <div className="flex w-full max-w-[420px] flex-col items-center gap-2.5 rounded-2xl border border-hairline px-4 py-3">
      <p className="text-[13px] text-muted">{t("settings.updatesDesc")}</p>
      <Segmented
        label={t("settings.updates")}
        value={channel}
        onChange={(updateChannel) => update({ updateChannel })}
        options={[
          { value: "stable", label: t("settings.channelStable") },
          { value: "beta", label: t("settings.channelBeta") },
        ]}
      />
      {channel === "beta" && <p className="text-[12px] text-muted">{t("settings.channelBetaDesc")}</p>}
      <Button
        size="sm"
        busy={checking}
        onClick={async () => {
          setChecking(true);
          try {
            const found = await backend().checkForUpdates();
            toast(found ? t("settings.updateFound", { version: found.version }) : t("settings.upToDate"), "success");
          } catch (reason) {
            toast(
              t("settings.updateCheckFailed", { reason: reason instanceof Error ? reason.message : String(reason) }),
              "error",
            );
          } finally {
            setChecking(false);
          }
        }}
      >
        {t("settings.checkUpdates")}
      </Button>
    </div>
  );
}

function About() {
  const { t } = useT();
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <LogoSymbol className="h-20 w-auto" title="UwUMail" />
      <div>
        <p className="text-[20px] font-extrabold">
          <span className="text-pink">UwU</span>Mail
        </p>
        <p className="text-[13px] text-muted">{t("settings.version", { version: pkg.version })}</p>
      </div>
      <p className="max-w-[360px] text-[13px] text-muted">{t("settings.license")}</p>
      {backend().kind === "demo" && (
        <p className="rounded-full bg-pink-tint px-3 py-1 text-[12.5px] font-semibold text-pink-ink">
          {t("status.demo")}
        </p>
      )}
      <UpdateSettings />
      <div className="flex flex-wrap justify-center gap-2">
        <Button icon={ExternalLink} onClick={() => void openLinkNow("https://github.com/MinifyX/UwUMail-Client")}>
          {t("settings.source")}
        </Button>
        <Button icon={Keyboard} onClick={() => setShortcutsOpen(true)}>
          {t("settings.shortcuts")}
        </Button>
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const { t } = useT();
  const section = useUi((s) => s.settingsOpen);
  const openSettings = useUi((s) => s.openSettings);
  const closeSettings = useUi((s) => s.closeSettings);

  return (
    <Dialog open={section !== null} onClose={closeSettings} title={t("settings.title")} width="lg">
      <div className="flex min-h-[460px] flex-col gap-2 px-4 pb-5 sm:flex-row sm:gap-6 sm:px-6">
        <nav className="flex shrink-0 gap-1 overflow-x-auto sm:w-48 sm:flex-col" aria-label={t("settings.title")}>
          {SECTIONS.filter((item) => !item.androidOnly || nativeAndroid).map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => openSettings(id)}
              aria-current={section === id ? "page" : undefined}
              className={clsx(
                "flex h-10 shrink-0 items-center gap-3 rounded-xl px-3 text-left text-[13.5px] font-semibold transition-colors",
                section === id ? "bg-pink-tint text-pink-ink" : "text-muted hover:bg-pink-tint/50 hover:text-ink",
              )}
            >
              <Icon className="size-[17px]" aria-hidden />
              {t(`settings.${id}`)}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          {section === "appearance" && <Appearance />}
          {section === "mail" && <Reading />}
          {section === "compose" && <Writing />}
          {section === "security" && <Security />}
          {section === "accounts" && <Accounts />}
          {section === "addons" && <Addons />}
          {section === "about" && <About />}
        </div>
      </div>
    </Dialog>
  );
}
