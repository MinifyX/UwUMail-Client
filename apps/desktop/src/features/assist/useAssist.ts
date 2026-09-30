import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AssistError, backend, BackendError } from "@/backend/backend";
import {
  type AssistAnswer,
  type AssistFeature,
  type AssistLabel,
  type AssistOptions,
  type AssistScope,
  type AssistStreamHandlers,
  DEVICE_ASSIST_SCOPE,
} from "@/backend/types";
import { translate } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { useAssistCurrency } from "./cost";

const ScopeContext = createContext<string>(DEVICE_ASSIST_SCOPE);
const AccountContext = createContext<string | null>(null);

/**
 * Where the assistant's settings live for everything below: a UwUMail account's server, or
 * `"device"` (the providers set up on this device).
 */
export function AssistScopeProvider({ scope, children }: { scope: string; children: ReactNode }) {
  return createElement(ScopeContext.Provider, { value: scope }, children);
}

/** The scope the settings below talk to. */
export function useAssistScope(): string {
  return useContext(ScopeContext);
}

/** Every place the assistant's settings live; empty without any assistant. */
export function useAssistScopes() {
  return useQuery({ queryKey: queryKeys.assistScopes, queryFn: () => backend().assistScopes(), staleTime: 60_000 });
}

/** The scope that serves one mailbox, when there is one. */
export function useScopeOf(accountId: string | null | undefined): AssistScope | null {
  const { data: scopes = [] } = useAssistScopes();
  if (!accountId) return null;
  return scopes.find((scope) => scope.accountIds.includes(accountId)) ?? null;
}

/**
 * The assistant for one mailbox: its scope for labels and settings, and its features. Everything
 * about a mail (summary, spam check, labels, the composer's menu) sits below this.
 */
export function AssistForAccount({ accountId, children }: { accountId: string; children: ReactNode }) {
  const scope = useScopeOf(accountId);
  return createElement(
    AccountContext.Provider,
    { value: accountId },
    createElement(ScopeContext.Provider, { value: scope?.id ?? DEVICE_ASSIST_SCOPE }, children),
  );
}

/** What the assistant may do in the current scope; null hides everything about it. */
export function useAssistOptions(): { data: AssistOptions | null } {
  const scope = useAssistScope();
  const { data: scopes } = useAssistScopes();
  return { data: scopes?.find((each) => each.id === scope)?.options ?? null };
}

/**
 * Per feature whether it can be used for the current mailbox (or the one given); null without an
 * assistant.
 */
export function useAssistFeatures(forAccount?: string) {
  const context = useContext(AccountContext);
  const accountId = forAccount ?? context;
  return useQuery({
    queryKey: [...queryKeys.assistFeatures, accountId],
    queryFn: () => backend().assistFeatures(accountId!),
    enabled: Boolean(accountId),
    staleTime: 60_000,
  });
}

/** Whether one feature can be used now. */
export function useAssistFeature(feature: AssistFeature, forAccount?: string): boolean {
  const { data } = useAssistFeatures(forAccount);
  return data?.[feature] === true;
}

export function useAssistSettings(enabled = true) {
  const scope = useAssistScope();
  const { data: options } = useAssistOptions();
  return useQuery({
    queryKey: [...queryKeys.assistSettings, scope],
    queryFn: () => backend().assistSettings(scope),
    enabled: enabled && Boolean(options),
  });
}

export function useAssistProviders(enabled = true) {
  const scope = useAssistScope();
  const { data: options } = useAssistOptions();
  return useQuery({
    queryKey: [...queryKeys.assistProviders, scope],
    queryFn: () => backend().assistProviders(scope),
    enabled: enabled && Boolean(options),
  });
}

/** The person's labels in the current scope. */
export function useAssistLabels() {
  const scope = useAssistScope();
  const { data: options } = useAssistOptions();
  return useQuery({
    queryKey: [...queryKeys.assistLabels, scope],
    queryFn: () => backend().assistLabels(scope),
    enabled: Boolean(options),
    staleTime: 5 * 60_000,
  });
}

/** Labels by the keyword they put on mail. */
export function useLabelsByKeyword(): Map<string, AssistLabel> {
  const { data: labels = [] } = useAssistLabels();
  return new Map(labels.map((label) => [label.keyword, label]));
}

/** Why the model put labels on a mail, for mail that carries any. */
export function useLabelLog(emailId: string, enabled: boolean) {
  const scope = useAssistScope();
  return useQuery({
    queryKey: [...queryKeys.assistLabelLog, scope, emailId],
    queryFn: () => backend().assistLabelLog(scope, [emailId], 50),
    enabled,
    staleTime: 60_000,
  });
}

/** The newest entries of the label log of the current scope. */
export function useLabelLogList(limit: number) {
  const scope = useAssistScope();
  return useQuery({
    queryKey: [...queryKeys.assistLabelLog, scope, "latest", limit],
    queryFn: () => backend().assistLabelLog(scope, null, limit),
    staleTime: 30_000,
  });
}

export function useAssistUsage(enabled = true) {
  const scope = useAssistScope();
  const { data: options } = useAssistOptions();
  const currency = useAssistCurrency();
  return useQuery({
    queryKey: [...queryKeys.assistUsage, scope, currency],
    queryFn: () => backend().assistUsage(scope, 30, currency),
    enabled: enabled && Boolean(options),
    // Every request changes it; the global cache time would show old numbers for a while.
    staleTime: 0,
  });
}

/** The mailbox the assistant works for right now (below `AssistForAccount`). */
export function useAssistAccount(): string | null {
  return useContext(AccountContext);
}

/** Whether an error only says that the request was called off. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** What went wrong with the assistant, in the reader's words. */
export function assistErrorText(error: unknown): string {
  if (error instanceof AssistError) {
    switch (error.type) {
      case "assistUnavailable":
        return translate("assist.error.unavailable");
      case "overQuota":
        return translate("assist.error.overQuota");
      case "providerFailed":
        return error.retryAfter
          ? translate("assist.error.busy", { seconds: Math.ceil(error.retryAfter) })
          : translate("assist.error.providerFailed");
      case "notFound":
        return translate("assist.error.notFound");
      case "forbidden":
        return translate("assist.error.forbidden");
      case "invalidArguments":
      case "invalidProperties":
        return error.description
          ? translate("assist.error.invalidWith", { reason: error.description })
          : translate("assist.error.invalid");
    }
  }
  if (error instanceof BackendError) {
    if (error.code === "connection_failed") return translate("assist.error.connection");
    if (error.code === "auth_failed") return translate("assist.error.signedOut");
  }
  return translate("assist.error.generic");
}

/** The provider's own words, where they say more than the friendly text: for a "details" line. */
export function assistErrorDetail(error: unknown): string | null {
  return error instanceof AssistError && error.type === "providerFailed" ? error.description : null;
}

export type StreamStatus = "idle" | "working" | "done" | "error";

export interface StreamState {
  status: StreamStatus;
  text: string;
  subject: string | null;
  answer: AssistAnswer | null;
  error: unknown;
}

const IDLE: StreamState = { status: "idle", text: "", subject: null, answer: null, error: null };

/**
 * One answer of the assistant at a time, as it streams in. Starting again or leaving calls the
 * one before off, which closes its request and stops the model.
 */
export function useAssistStream() {
  const [state, setState] = useState<StreamState>(IDLE);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const run = useCallback(
    async <T extends AssistAnswer>(
      start: (handlers: AssistStreamHandlers) => Promise<T>,
      finalText: (answer: T) => { text: string; subject?: string | null },
    ): Promise<T | null> => {
      controller.current?.abort();
      const own = new AbortController();
      controller.current = own;
      setState({ ...IDLE, status: "working" });
      try {
        const answer = await start({
          signal: own.signal,
          onSubject: (subject) => {
            if (!own.signal.aborted) setState((current) => ({ ...current, subject }));
          },
          onDelta: (text) => {
            if (!own.signal.aborted) setState((current) => ({ ...current, text: current.text + text }));
          },
        });
        if (own.signal.aborted) return null;
        const final = finalText(answer);
        setState({
          status: "done",
          text: final.text,
          subject: final.subject ?? null,
          answer,
          error: null,
        });
        return answer;
      } catch (error) {
        if (own.signal.aborted || isAbort(error)) return null;
        setState((current) => ({ ...current, status: "error", error }));
        return null;
      } finally {
        if (controller.current === own) controller.current = null;
      }
    },
    [],
  );

  /** Calls the answer off; what came so far stays readable. */
  const stop = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState((current) => (current.status === "working" ? { ...current, status: "done" } : current));
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    setState(IDLE);
  }, []);

  return { state, run, stop, reset };
}

/** "Mistral (Server) · mistral-small-latest" */
export function providerLabel(answer: { providerName: string; model: string | null } | null | undefined): string {
  if (!answer) return "";
  return answer.model ? `${answer.providerName} · ${answer.model}` : answer.providerName;
}
