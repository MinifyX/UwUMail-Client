import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  CircleCheck,
  CircleDashed,
  Copy,
  Cpu,
  ExternalLink,
  FlaskConical,
  KeyRound,
  LogIn,
  Pencil,
  Plus,
  Server,
  Trash,
  UserRound,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AssistError, backend } from "@/backend/backend";
import {
  type AssistOptions,
  type AssistProbeInput,
  type AssistProvider,
  type AssistProviderKind,
  type ChatgptLogin,
  DEVICE_ASSIST_SCOPE,
  type LocalModelServer,
} from "@/backend/types";
import { Button, Field, IconButton, Select, TextInput } from "@uwusuite/design";
import { useT } from "@/i18n";
import { ASSIST_KINDS, assistKind } from "@/lib/assistKinds";
import { queryKeys } from "@/lib/queries";
import { openLinkNow } from "@/state/links";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import {
  emptyProviderForm,
  insecureUrl,
  isFreeKind,
  PROVIDER_NAME_MAX,
  providerCreateInput,
  providerFormFrom,
  providerProblems,
  providerUpdateInput,
  type ProviderForm,
} from "../providerForm";
import { assistErrorDetail, assistErrorText, useAssistProviders, useAssistScope } from "../useAssist";
import { useSettled } from "../estimate";
import { ModelInput, Note, Section } from "./common";

/** The server's providers the person may use, and their own ones with add, change, test and remove. */
export function ProviderSettings({ options }: { options: AssistOptions }) {
  const { t } = useT();
  const { data: providers = [], isPending } = useAssistProviders();
  const scope = useAssistScope();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [signIn, setSignIn] = useState<string | null>(null);
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  // Leaving the settings asks first while a provider is half entered.
  useEffect(() => {
    setSettingsFormDirty(editing !== null);
    return () => setSettingsFormDirty(false);
  }, [editing, setSettingsFormDirty]);

  const server = providers.filter((provider) => provider.scope === "server");
  const own = providers.filter((provider) => provider.scope === "personal");
  const room = own.length < options.maxProviders;

  return (
    <Section
      title={t("assist.providers.title")}
      description={t("assist.providers.description")}
      action={
        options.mayAddProviders &&
        editing !== "new" && (
          <Button size="sm" icon={Plus} disabled={!room} onClick={() => setEditing("new")}>
            {t("assist.providers.add")}
          </Button>
        )
      }
    >
      {options.mayAddProviders && scope === DEVICE_ASSIST_SCOPE && room && editing === null && <LocalModels />}
      {editing === "new" && (
        <ProviderEditor
          provider={null}
          options={options}
          onDone={(made) => {
            setEditing(null);
            if (made?.kind === "chatgpt") setSignIn(made.id);
          }}
        />
      )}
      {!isPending && providers.length === 0 && editing !== "new" && (
        <p className="text-[13px] text-muted">{t("assist.providers.empty")}</p>
      )}
      {options.mayAddProviders && !room && (
        <p className="text-[12.5px] text-muted">{t("assist.providers.full", { count: options.maxProviders })}</p>
      )}
      {!options.mayAddProviders && <Note>{t("assist.providers.noOwn")}</Note>}
      <ul className="flex flex-col gap-2">
        {server.map((provider) => (
          <ServerProvider key={provider.id} provider={provider} />
        ))}
        {own.map((provider) =>
          editing === provider.id ? (
            <li key={provider.id}>
              <ProviderEditor provider={provider} options={options} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <OwnProvider
              key={provider.id}
              provider={provider}
              signingIn={signIn === provider.id}
              onEdit={() => setEditing(provider.id)}
              onSignIn={(on) => setSignIn(on ? provider.id : null)}
            />
          ),
        )}
      </ul>
    </Section>
  );
}

/**
 * Ollama or LM Studio running on this computer: offered with one click, with a model picked from
 * the installed ones. Only on this device's scope; a UwUMail server can't reach this computer.
 */
function LocalModels() {
  const { t } = useT();
  const { data: servers = [] } = useQuery({
    queryKey: queryKeys.assistLocalModels,
    queryFn: () => backend().assistLocalModels(),
    staleTime: 30_000,
    retry: false,
  });
  const offered = servers.filter((server) => !server.added);
  if (offered.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-pink/30 bg-pink-tint/20 px-3.5 py-3">
      <p className="flex items-center gap-2 text-[13px] font-bold">
        <Cpu className="size-4 shrink-0 text-pink" aria-hidden />
        {t("assist.local.title")}
      </p>
      <p className="text-[12.5px] text-muted">{t("assist.local.description")}</p>
      <ul className="flex flex-col gap-2">
        {offered.map((server) => (
          <LocalModelOffer key={server.baseUrl} server={server} />
        ))}
      </ul>
    </div>
  );
}

function LocalModelOffer({ server }: { server: LocalModelServer }) {
  const { t } = useT();
  const scope = useAssistScope();
  const client = useQueryClient();
  const [model, setModel] = useState(server.models[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const add = () => {
    setBusy(true);
    backend()
      .createAssistProvider(scope, {
        name: server.name,
        kind: server.kind,
        baseUrl: server.baseUrl,
        ...(model ? { model, fastModel: model } : {}),
      })
      .then(() => {
        toast(t("assist.providers.added", { name: server.name }), "success");
        for (const key of [queryKeys.assistProviders, queryKeys.assistSettings, queryKeys.assistLocalModels]) {
          void client.invalidateQueries({ queryKey: key });
        }
      })
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => setBusy(false));
  };
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-surface px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-bold">{server.name}</span>
        <span className="block truncate font-mono text-[11.5px] text-muted">{server.baseUrl}</span>
      </span>
      {server.models.length > 0 ? (
        <Select
          aria-label={t("assist.local.model", { name: server.name })}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="h-9 max-w-[min(100%,16rem)] text-[13px]"
        >
          {server.models.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id}
            </option>
          ))}
        </Select>
      ) : (
        <span className="text-[12.5px] text-muted">{t("assist.local.noModels")}</span>
      )}
      <Button size="sm" variant="primary" icon={Plus} busy={busy} onClick={add}>
        {t("assist.local.add")}
      </Button>
    </li>
  );
}

function ProviderIcon({ provider }: { provider: AssistProvider }) {
  const Icon = provider.scope === "server" ? Server : UserRound;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-canvas text-muted">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

function Models({ provider }: { provider: AssistProvider }) {
  const { t } = useT();
  if (!provider.model && !provider.fastModel) return null;
  return (
    <p className="truncate text-[12px] text-muted">
      {provider.fastModel && provider.fastModel !== provider.model
        ? t("assist.providers.models", { model: provider.model ?? "—", fastModel: provider.fastModel })
        : t("assist.providers.model", { model: provider.model ?? provider.fastModel })}
    </p>
  );
}

function ServerProvider({ provider }: { provider: AssistProvider }) {
  const { t, i18n } = useT();
  const number = new Intl.NumberFormat(i18n.language);
  const quota = provider.quota;
  const limits = [
    quota?.requestsPerDay != null
      ? t("assist.providers.requestsPerDay", {
          count: quota.requestsPerDay,
          formatted: number.format(quota.requestsPerDay),
        })
      : null,
    quota?.tokensPerDay != null
      ? t("assist.providers.tokensPerDay", { formatted: number.format(quota.tokensPerDay) })
      : null,
  ].filter(Boolean);
  return (
    <li className="flex gap-3 rounded-2xl border border-hairline bg-surface px-3.5 py-3">
      <ProviderIcon provider={provider} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13.5px] font-bold">{provider.name}</span>
          <span className="rounded-full bg-canvas px-2 py-px text-[11px] font-semibold text-muted">
            {t("assist.providers.server")}
          </span>
        </p>
        <Models provider={provider} />
        <p className="text-[12px] text-muted">
          {limits.length > 0 ? limits.join(" · ") : t("assist.providers.noLimit")}
        </p>
      </div>
    </li>
  );
}

function OwnProvider({
  provider,
  signingIn,
  onEdit,
  onSignIn,
}: {
  provider: AssistProvider;
  signingIn: boolean;
  onEdit: () => void;
  onSignIn: (on: boolean) => void;
}) {
  const { t } = useT();
  const scope = useAssistScope();
  const client = useQueryClient();
  const kind = assistKind(provider.kind);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const test = () => {
    setTesting(true);
    backend()
      .assistModels(scope, provider.id)
      .then((models) => {
        client.setQueryData(["assistModels", scope, provider.id], models);
        toast(t("assist.providers.testOk", { count: models.models.length }), "success");
      })
      .catch((error: unknown) => {
        const detail = assistErrorDetail(error);
        toast(detail ? `${assistErrorText(error)} ${detail}` : assistErrorText(error), "error");
      })
      .finally(() => setTesting(false));
  };

  const remove = () => {
    setDeleting(true);
    backend()
      .deleteAssistProvider(scope, provider.id)
      .then(() => {
        toast(t("assist.providers.deleted", { name: provider.name }), "success");
        void client.invalidateQueries({ queryKey: queryKeys.assistSettings });
      })
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => {
        setDeleting(false);
        setConfirmDelete(false);
      });
  };

  const status = provider.connected
    ? provider.kind === "chatgpt"
      ? t("assist.providers.signedIn")
      : t("assist.providers.ready")
    : provider.kind === "chatgpt"
      ? t("assist.providers.notSignedIn")
      : t("assist.providers.needsKey");

  return (
    <li className="flex flex-col gap-2.5 rounded-2xl border border-hairline bg-surface px-3.5 py-3">
      <div className="flex gap-3">
        <ProviderIcon provider={provider} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13.5px] font-bold break-words">{provider.name}</span>
            <span className="rounded-full bg-canvas px-2 py-px text-[11px] font-semibold text-muted">{kind.label}</span>
            {provider.experimental && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-tint px-2 py-px text-[11px] font-semibold text-warning">
                <FlaskConical className="size-3" aria-hidden />
                {t("assist.providers.experimental")}
              </span>
            )}
          </p>
          <Models provider={provider} />
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
            <span
              className={clsx("inline-flex items-center gap-1", provider.connected ? "text-success" : "text-warning")}
            >
              {provider.connected ? (
                <CircleCheck className="size-3.5" aria-hidden />
              ) : (
                <CircleDashed className="size-3.5" aria-hidden />
              )}
              {status}
            </span>
            {kind.key !== "none" && (
              <span className="inline-flex items-center gap-1">
                <KeyRound className="size-3.5" aria-hidden />
                {provider.hasKey
                  ? t("assist.providers.keyStored", { hint: provider.keyHint ?? "…" })
                  : t("assist.providers.noKey")}
              </span>
            )}
            {provider.baseUrl && <span className="min-w-0 truncate font-mono text-[11.5px]">{provider.baseUrl}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-start gap-0.5">
          <IconButton
            icon={Pencil}
            size="sm"
            label={t("assist.providers.edit", { name: provider.name })}
            onClick={onEdit}
          />
          <IconButton
            icon={Trash}
            size="sm"
            label={t("assist.providers.delete", { name: provider.name })}
            onClick={() => setConfirmDelete(true)}
          />
        </div>
      </div>
      {confirmDelete ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-danger-tint px-3 py-2 text-[12.5px] text-danger">
          <span className="min-w-0 flex-1">{t("assist.providers.confirmDelete")}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="danger" icon={Trash} busy={deleting} onClick={remove}>
            {t("assist.providers.deleteShort")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {provider.kind === "chatgpt" && !signingIn && (
            <Button
              size="sm"
              variant={provider.connected ? "ghost" : "primary"}
              icon={LogIn}
              onClick={() => onSignIn(true)}
            >
              {provider.connected ? t("assist.chatgpt.again") : t("assist.chatgpt.signIn")}
            </Button>
          )}
          {(provider.connected || provider.kind !== "chatgpt") && (
            <Button size="sm" variant="ghost" icon={Zap} busy={testing} onClick={test}>
              {t("assist.providers.test")}
            </Button>
          )}
        </div>
      )}
      {signingIn && <ChatgptSignIn provider={provider} onClose={() => onSignIn(false)} />}
    </li>
  );
}

/** The fields the server named as wrong, with its words. */
function serverProblems(error: unknown): Partial<Record<string, string>> {
  if (!(error instanceof AssistError) || error.type !== "invalidProperties") return {};
  const text = error.description ?? error.type;
  return Object.fromEntries(error.properties.map((property) => [property, text]));
}

/** Adding or changing an own provider. */
function ProviderEditor({
  provider,
  options,
  onDone,
}: {
  provider: AssistProvider | null;
  options: AssistOptions;
  onDone: (made?: AssistProvider) => void;
}) {
  const { t, i18n } = useT();
  const scope = useAssistScope();
  const [form, setForm] = useState<ProviderForm>(() =>
    provider ? providerFormFrom(provider) : emptyProviderForm("openai"),
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const kind = assistKind(form.kind);
  const problems = providerProblems(form, provider);
  const fromServer = serverProblems(failure);
  // A new provider at its own address on this device lists its models before it is saved.
  const settledUrl = useSettled(form.baseUrl.trim());
  const probe: AssistProbeInput | null =
    !provider && scope === DEVICE_ASSIST_SCOPE && kind.baseUrl && settledUrl && !problems.baseUrl
      ? { kind: form.kind, baseUrl: settledUrl, apiKey: form.apiKey.trim() || null }
      : null;
  const change = (patch: Partial<ProviderForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFailure(null);
  };

  const problemText = (field: "name" | "baseUrl" | "apiKey" | "inputPrice" | "outputPrice"): string | undefined => {
    const problem = touched ? problems[field] : undefined;
    if (problem) return t(`assist.providers.problem.${problem}`, { max: PROVIDER_NAME_MAX });
    return fromServer[field === "inputPrice" || field === "outputPrice" ? `${field}PerMillion` : field];
  };
  // What the model is known to cost, as the placeholder of an empty price.
  const known = provider?.price && provider.price.source !== "manual" ? provider.price : null;
  const priceNumber = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 4 });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setFailure(null);
    const work = provider
      ? backend()
          .updateAssistProvider(scope, provider.id, providerUpdateInput(provider, form))
          .then(() => undefined)
      : backend().createAssistProvider(scope, providerCreateInput(form));
    work
      .then((made) => {
        toast(
          provider ? t("assist.providers.saved") : t("assist.providers.added", { name: form.name.trim() }),
          "success",
        );
        onDone(made ?? undefined);
      })
      .catch((error: unknown) => setFailure(error))
      .finally(() => setBusy(false));
  };

  const pickKind = (next: AssistProviderKind) => {
    const before = assistKind(form.kind);
    setForm((current) => ({
      ...emptyProviderForm(next),
      // A name the person typed stays; the kind's own name follows the kind.
      name: current.name.trim() && current.name !== before.label ? current.name : assistKind(next).label,
    }));
    setFailure(null);
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 rounded-2xl border border-pink/30 bg-pink-tint/20 px-4 py-3.5"
    >
      <p className="text-[13.5px] font-bold">
        {provider ? t("assist.providers.editTitle", { name: provider.name }) : t("assist.providers.addTitle")}
      </p>
      {!provider && (
        <Field label={t("assist.providers.kind")}>
          {(id) => (
            <Select id={id} value={form.kind} onChange={(event) => pickKind(event.target.value as AssistProviderKind)}>
              {ASSIST_KINDS.filter((entry) => scope !== DEVICE_ASSIST_SCOPE || !entry.signIn).map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.signIn ? `${entry.label} (${t("assist.providers.experimental")})` : entry.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {form.kind === "anthropic" && <Note>{t("assist.providers.anthropicNote")}</Note>}
      {form.kind === "chatgpt" && (
        <Note tone="warning">
          <p className="font-semibold">{t("assist.chatgpt.warningTitle")}</p>
          <p>{t("assist.chatgpt.warning")}</p>
        </Note>
      )}
      <Field label={t("assist.providers.name")} error={problemText("name")}>
        {(id) => (
          <TextInput
            id={id}
            value={form.name}
            maxLength={PROVIDER_NAME_MAX * 2}
            onChange={(event) => change({ name: event.target.value })}
          />
        )}
      </Field>
      {kind.baseUrl && (
        <Field
          label={t("assist.providers.baseUrl")}
          hint={
            options.mayUsePrivateAddresses
              ? t("assist.providers.baseUrlHintLan")
              : t("assist.providers.baseUrlHintNoLan")
          }
          error={problemText("baseUrl")}
        >
          {(id) => (
            <TextInput
              id={id}
              type="url"
              value={form.baseUrl}
              placeholder={kind.baseUrlExample}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => change({ baseUrl: event.target.value })}
            />
          )}
        </Field>
      )}
      {insecureUrl(form) && <Note tone="warning">{t("assist.providers.insecure")}</Note>}
      {kind.key !== "none" && (
        <Field
          label={kind.key === "optional" ? t("assist.providers.keyOptional") : t("assist.providers.key")}
          hint={
            provider?.hasKey
              ? t("assist.providers.keyKeep", { hint: provider.keyHint ?? "…" })
              : t("assist.providers.keyHint")
          }
          error={problemText("apiKey")}
        >
          {(id) => (
            <TextInput
              id={id}
              type="password"
              // Not a login's password: browsers ignore "off" here and would offer to save the key.
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={form.apiKey}
              placeholder={provider?.hasKey ? (provider.keyHint ?? "") : ""}
              onChange={(event) => change({ apiKey: event.target.value, removeKey: false })}
            />
          )}
        </Field>
      )}
      {(kind.keyUrl || (provider?.hasKey && kind.key === "optional")) && (
        <div className="-mt-1 flex flex-wrap items-center gap-3 text-[12.5px]">
          {kind.keyUrl && (
            <button
              type="button"
              onClick={() => void openLinkNow(kind.keyUrl!)}
              className="inline-flex items-center gap-1 rounded font-semibold text-pink-ink hover:underline focus-visible:shadow-focus focus-visible:outline-none"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {t("assist.providers.getKey", { provider: kind.label })}
            </button>
          )}
          {provider?.hasKey && kind.key === "optional" && (
            <label className="inline-flex items-center gap-1.5 text-muted">
              <input
                type="checkbox"
                checked={form.removeKey}
                onChange={(event) => change({ removeKey: event.target.checked, apiKey: "" })}
                className="size-3.5 accent-pink"
              />
              {t("assist.providers.removeKey")}
            </label>
          )}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("assist.providers.writeModel")} hint={t("assist.providers.writeModelHint")}>
          {() => (
            <ModelInput
              providerId={provider?.id ?? null}
              probe={probe}
              value={form.model}
              label={t("assist.providers.writeModel")}
              placeholder={kind.model || t("assist.providers.modelPlaceholder")}
              onCommit={(model) => change({ model })}
            />
          )}
        </Field>
        <Field label={t("assist.providers.fastModel")} hint={t("assist.providers.fastModelHint")}>
          {() => (
            <ModelInput
              providerId={provider?.id ?? null}
              probe={probe}
              value={form.fastModel}
              label={t("assist.providers.fastModel")}
              placeholder={kind.fastModel || t("assist.providers.modelPlaceholder")}
              onCommit={(fastModel) => change({ fastModel })}
            />
          )}
        </Field>
      </div>
      {!isFreeKind(form.kind) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(["inputPrice", "outputPrice"] as const).map((field) => (
            <Field
              key={field}
              label={t(`assist.providers.${field}`)}
              hint={t("assist.providers.priceHint")}
              error={problemText(field)}
            >
              {(id) => (
                <TextInput
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={form[field]}
                  placeholder={
                    known
                      ? t("assist.providers.priceAuto", {
                          price: priceNumber.format(
                            field === "inputPrice" ? known.inputPerMillion : known.outputPerMillion,
                          ),
                        })
                      : t("assist.providers.priceUnknown")
                  }
                  onChange={(event) => change({ [field]: event.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      {failure !== null && Object.keys(fromServer).length === 0 && (
        <p role="alert" className="rounded-xl bg-danger-tint px-3 py-2 text-[13px] text-danger">
          {assistErrorText(failure)}
          {assistErrorDetail(failure) && (
            <span className="block text-[12px] opacity-80">{assistErrorDetail(failure)}</span>
          )}
        </p>
      )}
      <p className="text-[12px] text-muted">{t("assist.providers.privacy")}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone()}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {provider
            ? t("common.save")
            : form.kind === "chatgpt"
              ? t("assist.chatgpt.addAndSignIn")
              : t("assist.providers.addShort")}
        </Button>
      </div>
    </form>
  );
}

/** The ChatGPT device-code sign-in: a code to enter at OpenAI, then waiting until it went through. */
function ChatgptSignIn({ provider, onClose }: { provider: AssistProvider; onClose: () => void }) {
  const { t } = useT();
  const scope = useAssistScope();
  const [login, setLogin] = useState<ChatgptLogin | null>(null);
  const [state, setState] = useState<"starting" | "waiting" | "expired" | "failed">("starting");
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (interval: number) => {
      timer = setTimeout(() => {
        backend()
          .chatgptPoll(scope, provider.id)
          .then((result) => {
            if (closed.current) return;
            if (result.status === "pending") poll(interval);
            else if (result.status === "connected") {
              toast(t("assist.chatgpt.connected"), "success");
              onClose();
            } else {
              setState(result.status);
              setProblem(result.description);
            }
          })
          .catch((error: unknown) => {
            if (closed.current) return;
            setState("failed");
            setProblem(assistErrorText(error));
          });
      }, interval * 1000);
    };
    backend()
      .chatgptLogin(scope, provider.id)
      .then((started) => {
        if (closed.current) return;
        setLogin(started);
        setState("waiting");
        poll(started.interval);
      })
      .catch((error: unknown) => {
        if (closed.current) return;
        setState("failed");
        setProblem(assistErrorText(error));
      });
    return () => {
      closed.current = true;
      if (timer) clearTimeout(timer);
    };
    // A new attempt starts a new sign-in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, attempt]);

  const again = () => {
    setLogin(null);
    setProblem(null);
    setState("starting");
    setAttempt((count) => count + 1);
  };

  return (
    <div
      className="flex flex-col gap-2.5 rounded-xl bg-canvas px-3.5 py-3 text-[13px]"
      role="status"
      aria-live="polite"
    >
      {state === "starting" && <p className="text-muted">{t("assist.chatgpt.starting")}</p>}
      {state === "waiting" && login && (
        <>
          <p>{t("assist.chatgpt.steps")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="selectable rounded-xl bg-surface px-3 py-1.5 font-mono text-[18px] font-bold tracking-[0.12em]">
              {login.userCode}
            </code>
            <IconButton
              icon={Copy}
              size="sm"
              label={t("assist.chatgpt.copyCode")}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(login.userCode)
                  .then(() => toast(t("assist.chatgpt.codeCopied"), "success"))
                  .catch(() => undefined)
              }
            />
            <Button
              size="sm"
              variant="primary"
              icon={ExternalLink}
              onClick={() => void openLinkNow(login.verificationUri)}
            >
              {t("assist.chatgpt.open")}
            </Button>
          </div>
          <p className="flex items-center gap-2 text-[12px] text-muted">
            <span
              className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
            {t("assist.chatgpt.waiting")}
          </p>
        </>
      )}
      {(state === "expired" || state === "failed") && (
        <p className="text-danger">
          {state === "expired" ? t("assist.chatgpt.expired") : t("assist.chatgpt.failed")}
          {problem && <span className="block text-[12px] opacity-80">{problem}</span>}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(state === "expired" || state === "failed") && (
          <Button size="sm" icon={LogIn} onClick={again}>
            {t("assist.chatgpt.again")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
