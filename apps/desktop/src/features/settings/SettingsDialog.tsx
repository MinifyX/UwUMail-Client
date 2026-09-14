import clsx from "clsx";
import { ExternalLink, Info, Keyboard, Mail, Palette, Plus, Puzzle, Upload, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import pkg from "../../../package.json";
import { backend } from "@/backend/backend";
import { AccountDot } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented, Select, Toggle } from "@/components/ui/Field";
import { LogoSymbol } from "@/components/ui/Logo";
import { i18n, useT } from "@/i18n";
import { openExternal } from "@/lib/platform";
import { useAccounts } from "@/lib/queries";
import { useSettings, type LanguageSetting } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi, type SettingsSection } from "@/state/ui";

const SECTIONS: { id: SettingsSection; icon: LucideIcon }[] = [
  { id: "appearance", icon: Palette },
  { id: "mail", icon: Mail },
  { id: "accounts", icon: Users },
  { id: "addons", icon: Puzzle },
  { id: "about", icon: Info },
];

function Row({ label, description, children }: { label: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 border-b border-hairline py-4 last:border-0">
      <div>
        <p className="text-sm font-semibold">{label}</p>
        {description && <p className="text-[13px] text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

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

function Reading() {
  const { t } = useT();
  const settings = useSettings();
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
    </>
  );
}

function Accounts() {
  const { t } = useT();
  const { data: accounts = [] } = useAccounts();
  const client = useQueryClient();
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);

  return (
    <div className="flex flex-col gap-3 py-4">
      <ul className="flex flex-col gap-2">
        {accounts.map((account) => (
          <li key={account.id} className="flex items-center gap-3 rounded-2xl border border-hairline px-4 py-3">
            <AccountDot color={account.color} className="size-3" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{account.email}</span>
              <span className="block text-[12.5px] text-muted">
                {account.displayName} ·{" "}
                {account.auth === "password" ? "IMAP" : account.auth === "microsoft" ? "Microsoft" : "Google"}
              </span>
            </span>
            <Button
              size="sm"
              variant="danger"
              onClick={async () => {
                if (!window.confirm(t("settings.removeAccountConfirm", { email: account.email }))) return;
                await backend().removeAccount(account.id);
                await client.invalidateQueries();
              }}
            >
              {t("settings.removeAccount")}
            </Button>
          </li>
        ))}
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

function About() {
  const { t } = useT();
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen);
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <LogoSymbol className="h-20 w-auto" title="UwUMail" />
      <div>
        <p className="text-[20px] font-extrabold">
          UwU<span className="text-pink">Mail</span>
        </p>
        <p className="text-[13px] text-muted">{t("settings.version", { version: pkg.version })}</p>
      </div>
      <p className="max-w-[360px] text-[13px] text-muted">{t("settings.license")}</p>
      {backend().kind === "demo" && (
        <p className="rounded-full bg-pink-tint px-3 py-1 text-[12.5px] font-semibold text-pink-ink">
          {t("status.demo")}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button icon={ExternalLink} onClick={() => void openExternal("https://github.com/MinifyX/UwUMail-Client")}>
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
          {SECTIONS.map(({ id, icon: Icon }) => (
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
          {section === "accounts" && <Accounts />}
          {section === "addons" && <Addons />}
          {section === "about" && <About />}
        </div>
      </div>
    </Dialog>
  );
}
