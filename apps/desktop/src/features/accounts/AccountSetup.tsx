import clsx from "clsx";
import { ChevronDown, CircleCheck, Info, KeyRound, ShieldAlert, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { backend, BackendError } from "@/backend/backend";
import {
  ACCOUNT_COLORS,
  type Account,
  type AccountColor,
  type DiscoveredSettings,
  type Protocol,
  type Security,
  type ServerSettings,
} from "@/backend/types";
import { COLOR_CLASSES } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Field, Segmented, Select, TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { isEmail } from "@/lib/format";
import { queryKeys } from "@/lib/queries";

interface AccountSetupProps {
  onDone: (account: Account) => void;
  footer?: ReactNode;
}

const PROVIDER_NAMES = { microsoft: "Microsoft", google: "Google" } as const;

function ServerFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ServerSettings;
  onChange: (v: ServerSettings) => void;
}) {
  const { t } = useT();
  return (
    <fieldset className="flex flex-col gap-3 rounded-2xl border border-hairline p-4">
      <legend className="px-1 text-[13px] font-bold">{label}</legend>
      <div className="grid grid-cols-[1fr_96px] gap-3">
        <Field label={t("account.host")}>
          {(id) => (
            <TextInput
              id={id}
              value={value.host}
              onChange={(e) => onChange({ ...value, host: e.target.value.trim() })}
            />
          )}
        </Field>
        <Field label={t("account.port")}>
          {(id) => (
            <TextInput
              id={id}
              inputMode="numeric"
              value={value.port}
              onChange={(e) => onChange({ ...value, port: Number(e.target.value.replace(/\D/g, "")) || 0 })}
            />
          )}
        </Field>
      </div>
      <Field label={t("account.security")}>
        {(id) => (
          <Select
            id={id}
            value={value.security}
            onChange={(e) => onChange({ ...value, security: e.target.value as Security })}
          >
            <option value="tls">{t("security.tls")}</option>
            <option value="starttls">{t("security.starttls")}</option>
            <option value="none">{t("security.none")}</option>
          </Select>
        )}
      </Field>
    </fieldset>
  );
}

export function AccountSetup({ onDone, footer }: AccountSetupProps) {
  const { t } = useT();
  const client = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [color, setColor] = useState<AccountColor>("pink");
  const [settings, setSettings] = useState<DiscoveredSettings | null>(null);
  const [protocol, setProtocol] = useState<Protocol>("imap");
  const [showServers, setShowServers] = useState(false);
  const [busy, setBusy] = useState<"discover" | "connect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const describeError = (reason: unknown) => {
    if (reason instanceof BackendError) {
      if (reason.code === "auth_failed") return t("account.errorAuth");
      if (reason.code === "connection_failed") return t("account.errorConnection");
      if (reason.code === "invalid_input") return t("account.errorInvalid");
      return reason.message;
    }
    return String(reason);
  };

  const discover = async () => {
    if (!isEmail(email)) {
      setError(t("account.errorInvalid"));
      return;
    }
    setError(null);
    setBusy("discover");
    try {
      const found = await backend().discoverSettings(email.trim());
      setSettings(found);
      // JMAP whenever the server offers it; IMAP stays one click away.
      setProtocol(found.jmap && !found.oauth ? "jmap" : "imap");
      setShowServers(found.source === "guess" && !found.jmap);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  const jmapPossible = Boolean(settings && !settings.oauth && settings.jmap?.trim());
  const usesJmap = jmapPossible && protocol === "jmap";
  const isFastmail = /fastmail/i.test(`${settings?.providerName ?? ""} ${settings?.jmap ?? ""}`);

  const connect = async () => {
    if (!settings) return;
    setError(null);
    setBusy("connect");
    try {
      const account = await backend().addAccount({
        displayName: displayName.trim() || email.split("@")[0]!,
        email: email.trim(),
        auth: settings.oauth ?? "password",
        password: settings.oauth ? undefined : password,
        imap: settings.imap,
        smtp: settings.smtp,
        username: settings.username,
        color,
        protocol: jmapPossible ? protocol : "imap",
        jmapUrl: settings.oauth ? undefined : settings.jmap?.trim() || undefined,
      });
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.accounts }),
        client.invalidateQueries({ queryKey: queryKeys.folders }),
      ]);
      onDone(account);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(null);
    }
  };

  if (!settings) {
    return (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void discover();
        }}
      >
        <Field label={t("account.name")}>
          {(id) => (
            <TextInput
              id={id}
              value={displayName}
              autoComplete="name"
              placeholder={t("account.namePlaceholder")}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          )}
        </Field>
        <Field label={t("account.email")} error={error}>
          {(id) => (
            <TextInput
              id={id}
              type="email"
              autoFocus
              autoComplete="email"
              value={email}
              placeholder={t("account.emailPlaceholder")}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          {footer ?? <span />}
          <Button type="submit" variant="primary" busy={busy === "discover"}>
            {busy === "discover" ? t("account.discovering") : t("account.continue")}
          </Button>
        </div>
      </form>
    );
  }

  const provider = settings.oauth ? PROVIDER_NAMES[settings.oauth] : null;
  // Passwords would travel readable over these connections.
  const cleartext = usesJmap
    ? /^http:\/\//i.test(settings.jmap?.trim() ?? "")
    : !provider && (settings.imap.security === "none" || settings.smtp.security === "none");

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void connect();
      }}
    >
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-canvas px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-bold">{email}</p>
          <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
            {settings.source === "guess" ? (
              <Info className="size-3.5 shrink-0" aria-hidden />
            ) : (
              <CircleCheck className="size-3.5 shrink-0 text-success" aria-hidden />
            )}
            {settings.source === "guess" && !settings.jmap
              ? t("account.guessed")
              : t("account.found", { provider: settings.providerName ?? settings.imap.host })}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setSettings(null)}>
          {t("account.changeAddress")}
        </Button>
      </div>

      {jmapPossible && (
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-muted">{t("account.protocol")}</span>
          <Segmented
            label={t("account.protocol")}
            value={protocol}
            onChange={setProtocol}
            options={[
              { value: "jmap", label: t("account.protocolJmap") },
              { value: "imap", label: t("account.protocolImap") },
            ]}
          />
          <p className="flex items-center gap-1.5 text-[12.5px] text-muted">
            <Zap className="size-3.5 shrink-0 text-pink-ink" aria-hidden />
            {usesJmap ? t("account.protocolJmapHint") : t("account.protocolImapHint")}
          </p>
        </div>
      )}

      {provider ? (
        <p className="flex gap-2 rounded-2xl bg-pink-tint/60 px-4 py-3 text-[13px] text-pink-ink">
          <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t("account.oauthHint", { provider })}
        </p>
      ) : (
        <Field
          label={t("account.password")}
          hint={usesJmap && isFastmail ? t("account.fastmailTokenHint") : t("account.appPasswordHint")}
          error={error}
        >
          {(id) => (
            <TextInput
              id={id}
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold text-muted">{t("account.color")}</span>
        <div className="flex gap-2" role="radiogroup" aria-label={t("account.color")}>
          {ACCOUNT_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={color === option}
              aria-label={option}
              onClick={() => setColor(option)}
              className={clsx(
                "size-8 rounded-full ring-offset-2 ring-offset-surface transition-transform hover:scale-110",
                COLOR_CLASSES[option].dot,
                color === option && "ring-2 ring-ink",
              )}
            />
          ))}
        </div>
      </div>

      {!provider && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setShowServers(!showServers)}
            aria-expanded={showServers}
            className="flex items-center gap-1.5 self-start text-[13px] font-semibold text-muted hover:text-ink"
          >
            <ChevronDown className={clsx("size-4 transition-transform", !showServers && "-rotate-90")} aria-hidden />
            {t("account.editServers")}
          </button>
          {showServers && (
            <div className="flex animate-fade flex-col gap-3">
              <Field label={t("account.username")}>
                {(id) => (
                  <TextInput
                    id={id}
                    value={settings.username}
                    onChange={(e) => setSettings({ ...settings, username: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("account.jmapUrl")} hint={t("account.jmapUrlHint")}>
                {(id) => (
                  <TextInput
                    id={id}
                    type="url"
                    placeholder="https://mail.example.com/.well-known/jmap"
                    value={settings.jmap ?? ""}
                    onChange={(e) => {
                      const jmap = e.target.value.trim();
                      setSettings({ ...settings, jmap: jmap || undefined });
                      if (jmap && !settings.jmap) setProtocol("jmap");
                    }}
                  />
                )}
              </Field>
              {!usesJmap && (
                <>
                  <ServerFields
                    label={t("account.imap")}
                    value={settings.imap}
                    onChange={(imap) => setSettings({ ...settings, imap })}
                  />
                  <ServerFields
                    label={t("account.smtp")}
                    value={settings.smtp}
                    onChange={(smtp) => setSettings({ ...settings, smtp })}
                  />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {provider && error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}

      {cleartext && (
        <p role="alert" className="flex gap-2 rounded-2xl bg-danger-tint px-4 py-3 text-[13px] text-danger">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <strong className="block">{t("account.cleartextTitle")}</strong>
            {t("account.cleartextBody")}
          </span>
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        {footer ?? <span />}
        <Button type="submit" variant="primary" busy={busy === "connect"} disabled={!provider && password.length === 0}>
          {busy === "connect"
            ? t("account.connecting")
            : settings.oauth === "microsoft"
              ? t("account.oauthMicrosoft")
              : settings.oauth === "google"
                ? t("account.oauthGoogle")
                : t("account.connect")}
        </Button>
      </div>
    </form>
  );
}
