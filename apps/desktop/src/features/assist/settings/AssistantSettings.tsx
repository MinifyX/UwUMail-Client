import { useQuery } from "@tanstack/react-query";
import { Button, Field, Icon, ICONS, Select, Toggle } from "@uwusuite/design";
import { backend } from "@/backend/backend";
import {
  ASSIST_FEATURES,
  type AssistChoice,
  type AssistFeature,
  type AssistOptions,
  type AssistProvider,
  type AssistScope,
  type AssistSettings,
  type AssistSettingsPatch,
} from "@/backend/types";
import { useT } from "@/i18n";
import { queryKeys, useAccounts } from "@/lib/queries";
import { CURRENCY_CHOICES, useSettings, type CurrencyChoice } from "@/state/settings";
import { toast } from "@/state/toasts";
import { confirmAiDestination } from "../consent";
import { mayChooseCurrency } from "../cost";
import { nextChoice, providersFor } from "../providerForm";
import {
  AssistScopeProvider,
  assistErrorText,
  providerLabel,
  useAssistProviders,
  useAssistScope,
  useAssistScopes,
  useAssistSettings,
} from "../useAssist";
import { ModelInput, Note, Section } from "./common";
import { ProviderSettings } from "./ProviderSettings";
import { UsageSettings } from "./UsageSettings";

/**
 * Settings → Assistant: one section per UwUMail account whose server has the assistant, and one
 * for this device (the providers set up here, for every other mailbox). Each says which provider
 * and model each feature uses, the own providers, the labels and whether they are set by
 * themselves, and what was used. Hidden without any assistant.
 */
export function AssistantSettings() {
  const { t } = useT();
  const { data: scopes = [] } = useAssistScopes();
  const { data: accounts = [] } = useAccounts();
  if (scopes.length === 0) return null;
  const nameOf = (scope: AssistScope) =>
    scope.kind === "device"
      ? t("assist.settings.device")
      : (accounts.find((account) => account.id === scope.accountId)?.email ?? scope.accountId ?? scope.id);
  const eventScopes = scopes.filter((scope) => scope.options.features.extractEvents).map((scope) => scope.id);
  return (
    <div className="flex flex-col gap-5 py-4">
      <div className="flex gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-pink-tint text-pink">
          <Icon icon={ICONS.ai} size="lg" />
        </span>
        <div>
          <p className="text-sm font-semibold">{t("assist.settings.title")}</p>
          <p className="text-[13px] text-muted">{t("assist.settings.description")}</p>
        </div>
      </div>
      {scopes.map((scope) => (
        <AssistScopeProvider key={scope.id} scope={scope.id}>
          <ScopeSettings scope={scope} name={nameOf(scope)} />
        </AssistScopeProvider>
      ))}
      <EventSettings scopes={eventScopes} />
      <ConsentSettings />
      <CurrencySetting />
    </div>
  );
}

/** Everything of one scope: a UwUMail server's assistant, or this device's providers. */
function ScopeSettings({ scope, name }: { scope: AssistScope; name: string }) {
  const { t } = useT();
  const options = scope.options;
  const available = ASSIST_FEATURES.filter((feature) => options.features[feature]);
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-line p-3.5" aria-label={name}>
      <div>
        <p className="truncate text-sm font-semibold">{name}</p>
        <p className="text-[12.5px] text-muted">
          {scope.kind === "device" ? t("assist.settings.deviceDescription") : t("assist.settings.serverDescription")}
        </p>
      </div>
      {available.length === 0 && (
        <Note>
          <p className="font-semibold text-ink">
            {scope.kind === "device" ? t("assist.settings.deviceNoneTitle") : t("assist.settings.noneTitle")}
          </p>
          <p>{scope.kind === "device" ? t("assist.settings.deviceNoneBody") : t("assist.settings.noneBody")}</p>
        </Note>
      )}
      {scope.kind === "device" && options.foreignServers.length > 0 && (
        <ServerAssistSetting servers={options.foreignServers} />
      )}
      <ChoiceSettings options={options} />
      <ProviderSettings options={options} />
      <UsageSettings />
    </section>
  );
}

/** Saves a change of the choices, and says so when the refusal comes. */
function useSaveSettings() {
  const scope = useAssistScope();
  return (patch: AssistSettingsPatch) =>
    backend()
      .updateAssistSettings(scope, patch)
      .catch((error: unknown) => toast(assistErrorText(error), "error"));
}

/**
 * This device's other mailboxes may use a UwUMail server's assistant instead of providers set up
 * here, when that server allows it. Off until chosen: their mail then goes to that server.
 */
export function ServerAssistSetting({ servers }: { servers: string[] }) {
  const { t } = useT();
  const { data: settings } = useAssistSettings();
  const { data: accounts = [] } = useAccounts();
  const saveSettings = useSaveSettings();
  if (!settings) return null;
  const nameOf = (accountId: string) => accounts.find((account) => account.id === accountId)?.email ?? accountId;
  const chosen = settings.serverAssist;
  // The other mailboxes' mail then goes to that server: only once the person agreed to it.
  const choose = (server: string | null) =>
    void (server ? confirmAiDestination(server, [...ASSIST_FEATURES]) : Promise.resolve(true))
      .then((allowed) => (allowed ? saveSettings({ serverAssist: server }) : undefined))
      .catch((error: unknown) => toast(assistErrorText(error), "error"));
  return (
    <Section title={t("assist.settings.serverAssist.title")}>
      <Toggle
        checked={chosen !== null}
        onChange={(on) => choose(on ? (servers[0] ?? null) : null)}
        label={
          servers.length === 1
            ? t("assist.settings.serverAssist.useOne", { server: nameOf(servers[0]!) })
            : t("assist.settings.serverAssist.use")
        }
        description={t("assist.settings.serverAssist.description")}
      />
      {chosen !== null && servers.length > 1 && (
        <Field label={t("assist.settings.serverAssist.which")}>
          {(id) => (
            <Select id={id} value={chosen} onChange={(event) => choose(event.target.value)}>
              {!servers.includes(chosen) && <option value={chosen}>{nameOf(chosen)}</option>}
              {servers.map((server) => (
                <option key={server} value={server}>
                  {nameOf(server)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {chosen !== null && (
        <Note tone="warning">
          <p className="font-semibold">{t("assist.settings.serverAssist.sentTitle", { server: nameOf(chosen) })}</p>
          <p>{t("assist.settings.serverAssist.sentBody")}</p>
        </Note>
      )}
    </Section>
  );
}

/** Which provider and model: one for everything, and per feature where wanted. */
function ChoiceSettings({ options }: { options: AssistOptions }) {
  const { t } = useT();
  const { data: settings } = useAssistSettings();
  const { data: providers = [] } = useAssistProviders();
  const saveSettings = useSaveSettings();
  const features = ASSIST_FEATURES.filter((feature) => options.features[feature]);
  if (!settings || features.length === 0) return null;
  const usable = providersFor(providers, null);
  return (
    <Section title={t("assist.settings.choiceTitle")} description={t("assist.settings.choiceDescription")}>
      <ChoiceRow
        label={t("assist.settings.default")}
        choice={settings.default}
        providers={usable}
        noneLabel={t("assist.settings.automatic")}
        onChange={(choice) => saveSettings({ default: choice })}
      />
      <div className="flex flex-col gap-1 rounded-2xl bg-canvas p-1.5">
        {features.map((feature) => (
          <FeatureChoice
            key={feature}
            feature={feature}
            settings={settings}
            providers={providersFor(providers, feature)}
          />
        ))}
      </div>
    </Section>
  );
}

function ChoiceRow({
  label,
  choice,
  providers,
  noneLabel,
  onChange,
}: {
  label: string;
  choice: AssistChoice | null;
  providers: AssistProvider[];
  noneLabel: string;
  onChange: (choice: AssistChoice | null) => void;
}) {
  const { t } = useT();
  const provider = providers.find((entry) => entry.id === choice?.providerId);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] font-semibold text-muted">{label}</p>
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label={label}
          value={choice?.providerId ?? ""}
          onChange={(event) => onChange(nextChoice(choice, { providerId: event.target.value }))}
          className="min-w-[12rem] flex-1"
        >
          <option value="">{noneLabel}</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
              {entry.scope === "server" ? ` · ${t("assist.settings.fromServer")}` : ""}
            </option>
          ))}
        </Select>
        {choice && (
          <ModelInput
            providerId={choice.providerId}
            value={choice.model ?? ""}
            label={t("assist.settings.model")}
            placeholder={provider?.model ?? t("assist.settings.providerModel")}
            onCommit={(model) => onChange(nextChoice(choice, { model }))}
            className="min-w-[10rem] flex-1"
          />
        )}
      </div>
    </div>
  );
}

/** One feature: what it really uses, and its own choice. */
function FeatureChoice({
  feature,
  settings,
  providers,
}: {
  feature: AssistFeature;
  settings: AssistSettings;
  providers: AssistProvider[];
}) {
  const { t } = useT();
  const choice = settings.features[feature];
  const effective = settings.effective[feature];
  const provider = providers.find((entry) => entry.id === choice?.providerId);
  const saveSettings = useSaveSettings();
  const set = (next: AssistChoice | null) => saveSettings({ features: { [feature]: next } });
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-surface px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-semibold">{t(`assist.feature.${feature}`)}</p>
        <p className="truncate text-[12px] text-muted">
          {effective
            ? t("assist.settings.effective", { provider: providerLabel(effective) })
            : t("assist.settings.effectiveNone")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2 sm:w-[55%] sm:flex-nowrap">
        <Select
          aria-label={t("assist.settings.featureProvider", { feature: t(`assist.feature.${feature}`) })}
          value={choice?.providerId ?? ""}
          onChange={(event) => set(nextChoice(choice, { providerId: event.target.value }))}
          className="min-w-[9rem] flex-1 [&_select]:h-9 [&_select]:text-[13px]"
        >
          <option value="">{t("assist.settings.asDefault")}</option>
          {providers.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </Select>
        {choice && (
          <ModelInput
            providerId={choice.providerId}
            value={choice.model ?? ""}
            label={t("assist.settings.model")}
            placeholder={
              (feature === "compose" ? provider?.model : (provider?.fastModel ?? provider?.model)) ??
              t("assist.settings.providerModel")
            }
            onCommit={(model) => set(nextChoice(choice, { model }))}
            className="min-w-[8rem] flex-1"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Appointments: whether the webmail asks the model by itself whenever a mail opens. Switched on
 * only once the person agreed to every place the mail would go for it (`scopes`).
 */
function EventSettings({ scopes }: { scopes: string[] }) {
  const { t } = useT();
  const refine = useSettings((s) => s.assistRefineEvents);
  const update = useSettings((s) => s.update);
  if (scopes.length === 0) return null;
  const change = async (assistRefineEvents: boolean) => {
    if (assistRefineEvents) {
      for (const scope of scopes) {
        if (!(await confirmAiDestination(scope, ["extractEvents"]))) return;
      }
    }
    update({ assistRefineEvents });
  };
  return (
    <Section title={t("assist.settings.eventsTitle")}>
      <Toggle
        checked={refine}
        onChange={(on) => void change(on).catch((error: unknown) => toast(assistErrorText(error), "error"))}
        label={t("assist.settings.refineEvents")}
        description={t("assist.settings.refineEventsDesc")}
      />
    </Section>
  );
}

/**
 * Where the person allowed the assistant to send mail (App Review 5.1.2(i)), each with a way to
 * take it back: from then on nothing goes there until they allow it again.
 */
export function ConsentSettings() {
  const { t, i18n } = useT();
  const { data: consents = [] } = useQuery({
    queryKey: queryKeys.assistConsents,
    queryFn: () => backend().assistConsents(),
  });
  const nameOf = (consent: { kind: string; name: string }) =>
    consent.kind === "uwumailServer" ? t("assist.consent.settings.server", { name: consent.name }) : consent.name;
  const revoke = (destination: string, name: string) =>
    void backend()
      .revokeAssistConsent(destination)
      .then(() => toast(t("assist.consent.settings.revoked", { name }), "success"))
      .catch((error: unknown) => toast(assistErrorText(error), "error"));
  return (
    <Section title={t("assist.consent.settings.title")} description={t("assist.consent.settings.description")}>
      {consents.length === 0 ? (
        <p className="text-[12.5px] text-muted">{t("assist.consent.settings.none")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {consents.map((consent) => (
            <li
              key={consent.destination}
              className="flex flex-wrap items-center gap-2 rounded-xl bg-canvas px-3 py-2.5"
            >
              <div className="min-w-[min(100%,12rem)] flex-1">
                <p className="truncate text-[13.5px] font-semibold">{nameOf(consent)}</p>
                <p className="truncate text-[12px] text-muted">
                  {t("assist.consent.settings.grantedAt", {
                    host: consent.host,
                    date: new Date(consent.grantedAt * 1000).toLocaleDateString(i18n.language),
                  })}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("assist.consent.settings.revokeLabel", { name: nameOf(consent) })}
                onClick={() => revoke(consent.destination, nameOf(consent))}
              >
                {t("assist.consent.settings.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** In English the person picks euros or dollars for the costs; other languages have their own. */
export function CurrencySetting() {
  const { t, i18n } = useT();
  const currency = useSettings((s) => s.assistCurrency);
  const update = useSettings((s) => s.update);
  if (!mayChooseCurrency(i18n.language)) return null;
  return (
    <Section title={t("assist.settings.costsTitle")}>
      <Field label={t("assist.settings.currency")} hint={t("assist.settings.currencyHint")}>
        {(id) => (
          <Select
            id={id}
            value={currency}
            onChange={(event) => update({ assistCurrency: event.target.value as CurrencyChoice })}
          >
            {CURRENCY_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t(`assist.settings.currencies.${choice}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Section>
  );
}
