/**
 * The form for an own AI provider: what it needs per kind, what is wrong with it before the
 * server is asked, and only the changed fields for `AssistProvider/set`. The server checks
 * everything again (and more: private addresses, unencrypted keys over the internet).
 */

import type {
  AssistChoice,
  AssistFeature,
  AssistProvider,
  AssistProviderInput,
  AssistProviderKind,
} from "@/backend/types";
import { assistKind } from "@/lib/assistKinds";

export interface ProviderForm {
  name: string;
  kind: AssistProviderKind;
  baseUrl: string;
  /** Typed only: empty keeps the stored key when editing. */
  apiKey: string;
  /** Editing: the stored key is to go. */
  removeKey: boolean;
  model: string;
  fastModel: string;
}

export const PROVIDER_NAME_MAX = 60;

export function emptyProviderForm(kind: AssistProviderKind): ProviderForm {
  const info = assistKind(kind);
  return { name: info.label, kind, baseUrl: "", apiKey: "", removeKey: false, model: "", fastModel: "" };
}

export function providerFormFrom(provider: AssistProvider): ProviderForm {
  return {
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl ?? "",
    apiKey: "",
    removeKey: false,
    model: provider.model ?? "",
    fastModel: provider.fastModel ?? "",
  };
}

export type ProviderProblem = "nameMissing" | "nameTooLong" | "urlMissing" | "urlScheme" | "urlLogin" | "keyMissing";

/** Whether a host is on this machine or in a private network, where `http://` is fine. */
export function isPrivateHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".lan")) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(name);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  return name === "::1" || /^f[cd][0-9a-f]{2}:/.test(name) || /^fe80:/.test(name);
}

/** What is wrong with the form, per field; empty when it can go to the server. */
export function providerProblems(
  form: ProviderForm,
  stored: Pick<AssistProvider, "hasKey"> | null,
): Partial<Record<"name" | "baseUrl" | "apiKey", ProviderProblem>> {
  const problems: Partial<Record<"name" | "baseUrl" | "apiKey", ProviderProblem>> = {};
  const info = assistKind(form.kind);
  const name = form.name.trim();
  if (!name) problems.name = "nameMissing";
  else if ([...name].length > PROVIDER_NAME_MAX) problems.name = "nameTooLong";
  if (info.baseUrl) {
    const url = form.baseUrl.trim();
    if (!url) problems.baseUrl = "urlMissing";
    else {
      const parsed = URL.canParse(url) ? new URL(url) : null;
      if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
        problems.baseUrl = "urlScheme";
      } else if (parsed.username || parsed.password) problems.baseUrl = "urlLogin";
    }
  }
  if (info.key === "required") {
    const keeps = stored?.hasKey === true && !form.removeKey;
    if (!form.apiKey.trim() && !keeps) problems.apiKey = "keyMissing";
  }
  return problems;
}

/** An `http://` address outside the local network: the server refuses to send a key there. */
export function insecureUrl(form: ProviderForm): boolean {
  if (!assistKind(form.kind).baseUrl) return false;
  try {
    const url = new URL(form.baseUrl.trim());
    return url.protocol === "http:" && !isPrivateHost(url.hostname);
  } catch {
    return false;
  }
}

/** A new provider as `AssistProvider/set` creates it. */
export function providerCreateInput(form: ProviderForm): AssistProviderInput {
  const info = assistKind(form.kind);
  const input: AssistProviderInput = { name: form.name.trim(), kind: form.kind };
  if (info.baseUrl) input.baseUrl = form.baseUrl.trim();
  if (info.key !== "none" && form.apiKey.trim()) input.apiKey = form.apiKey.trim();
  if (form.model.trim()) input.model = form.model.trim();
  if (form.fastModel.trim()) input.fastModel = form.fastModel.trim();
  return input;
}

/** Only what changed; a key only when one was typed, `""` when it is to go. */
export function providerUpdateInput(provider: AssistProvider, form: ProviderForm): AssistProviderInput {
  const info = assistKind(provider.kind);
  const patch: AssistProviderInput = {};
  if (form.name.trim() !== provider.name) patch.name = form.name.trim();
  if (info.baseUrl && form.baseUrl.trim() !== (provider.baseUrl ?? "")) patch.baseUrl = form.baseUrl.trim();
  if (info.key !== "none") {
    if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
    else if (form.removeKey && provider.hasKey) patch.apiKey = "";
  }
  if (form.model.trim() !== (provider.model ?? "")) patch.model = form.model.trim() || null;
  if (form.fastModel.trim() !== (provider.fastModel ?? "")) patch.fastModel = form.fastModel.trim() || null;
  return patch;
}

/** A choice as the value of one `<select>`: `""` for none, else `providerId`. */
export function choiceProvider(choice: AssistChoice | null | undefined): string {
  return choice?.providerId ?? "";
}

/**
 * The choice after picking a provider or a model; a new provider drops the model, which belongs
 * to the one before.
 */
export function nextChoice(
  current: AssistChoice | null,
  change: { providerId?: string; model?: string | null },
): AssistChoice | null {
  const providerId = change.providerId ?? current?.providerId ?? "";
  if (!providerId) return null;
  const sameProvider = current?.providerId === providerId;
  const model = change.model !== undefined ? change.model?.trim() || null : sameProvider ? current.model : null;
  return { providerId, model };
}

/** The providers that may be used for a feature: server ones as the admin allowed, own ones when ready. */
export function providersFor(providers: readonly AssistProvider[], feature: AssistFeature | null): AssistProvider[] {
  return providers.filter(
    (provider) => (feature === null || provider.features.includes(feature as AssistFeature)) && provider.connected,
  );
}
