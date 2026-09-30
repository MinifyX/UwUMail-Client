import clsx from "clsx";
import { Check, Plus, RotateCcw, Tags, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { backend } from "@/backend/backend";
import type { AssistLabelSuggestion, AssistNewLabel, Message } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { hasLabel, labelRef, type LabelEntry } from "@/lib/labelFilter";
import { toast } from "@/state/toasts";
import { useLabelActions } from "../labels/labelActions";
import { labelsFor, useLabelDirectory } from "../labels/useLabels";
import { Thinking } from "./ComposeAssist";
import { LABEL_COLORS, chipStyle } from "./labels";
import { useAssistReader } from "./readerState";
import { assistErrorDetail, assistErrorText, isAbort, providerLabel, useScopeOf } from "./useAssist";

/** Which labels to have on after "Apply": what the model found fitting, to start with. */
export function initialChoice(result: AssistLabelSuggestion): Record<string, boolean> {
  return Object.fromEntries(result.verdicts.map((verdict) => [verdict.labelId, verdict.fits]));
}

/** The keyword changes "Apply" makes: only labels whose tick differs from what the mail has now. */
export function labelChanges(
  message: Pick<Message, "accountId" | "keywords">,
  entries: readonly LabelEntry[],
  choice: Record<string, boolean>,
): Record<string, boolean> {
  const changes: Record<string, boolean> = {};
  for (const entry of entries) {
    const wanted = choice[entry.label.id];
    if (wanted === undefined) continue;
    if (hasLabel(message, labelRef(entry)) !== wanted) changes[entry.label.keyword] = wanted;
  }
  return changes;
}

/**
 * "Label again": the model goes through every label of the mail's place and says for each
 * whether it fits and why, and may propose up to two new ones. Nothing changes until the person
 * applies the ticks or makes a proposed label.
 */
export function LabelSuggestCard({ message }: { message: Message }) {
  const { t, i18n } = useT();
  const saved = useAssistReader((s) => s.labelResults[message.id]);
  const remember = useAssistReader((s) => s.rememberLabelCheck);
  const hide = useAssistReader((s) => s.hideLabelCheck);
  const { entries: directory } = useLabelDirectory();
  const entries = labelsFor(directory, message.accountId);
  const scope = useScopeOf(message.accountId);
  const { setOnMessages, refresh } = useLabelActions();
  const [state, setState] = useState<{ working: boolean; error: unknown }>({ working: !saved, error: null });
  const [choice, setChoice] = useState<Record<string, boolean>>(() => (saved ? initialChoice(saved) : {}));
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<string[]>([]);
  const controller = useRef<AbortController | null>(null);

  const ask = () => {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setState({ working: true, error: null });
    backend()
      .suggestLabels(message.id, i18n.language, true)
      .then((result) => {
        if (own.signal.aborted) return;
        remember(result);
        setChoice(initialChoice(result));
        setMade([]);
        setState({ working: false, error: null });
      })
      .catch((error: unknown) => {
        if (own.signal.aborted || isAbort(error)) return;
        setState({ working: false, error });
      });
  };

  // Started a tick later, so a mount that is undone at once (React's strict mode) asks only once.
  useEffect(() => {
    const timer = saved ? undefined : setTimeout(ask, 0);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changes = labelChanges(message, entries, choice);
  const changeCount = Object.keys(changes).length;

  const apply = async () => {
    setBusy("apply");
    try {
      await backend().setKeywords([message.id], changes);
      toast(t("assist.labelAgain.applied", { count: changeCount }), "success");
      hide(message.id);
    } catch (error) {
      toast(assistErrorText(error), "error");
    } finally {
      refresh();
      setBusy(null);
    }
  };

  const create = async (proposal: AssistNewLabel, index: number) => {
    if (!scope) return;
    setBusy(`new:${index}`);
    try {
      const label = await backend().createAssistLabel(scope.id, {
        name: proposal.name,
        description: proposal.description,
        color: proposal.color ?? LABEL_COLORS[entries.length % LABEL_COLORS.length]!,
      });
      await setOnMessages([message], { scope: scope.id, accountIds: scope.accountIds, label }, true);
      setMade((names) => [...names, proposal.name]);
      toast(t("labels.createdApplied", { name: label.name }), "success");
    } catch (error) {
      toast(assistErrorText(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const result = !state.working && state.error === null ? saved : undefined;

  return (
    <section
      aria-label={t("assist.labelAgain.title")}
      className="flex animate-fade flex-col gap-3 rounded-[18px] border border-line bg-canvas px-4 py-3"
    >
      <header className="flex items-center gap-2">
        <Tags className="size-4 shrink-0 text-pink" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-bold">{t("assist.labelAgain.title")}</h3>
        {result && (
          <span className="hidden min-w-0 truncate text-[11.5px] font-semibold text-muted sm:inline">
            {providerLabel(result)}
          </span>
        )}
        {!state.working && <IconButton icon={RotateCcw} size="sm" label={t("assist.labelAgain.again")} onClick={ask} />}
        <IconButton icon={X} size="sm" label={t("assist.labelAgain.close")} onClick={() => hide(message.id)} />
      </header>

      {state.working && (
        <div role="status" aria-live="polite">
          <Thinking />
        </div>
      )}
      {!state.working && state.error !== null && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-[13px] text-danger">
          <span className="min-w-0 flex-1">
            {assistErrorText(state.error)}
            {assistErrorDetail(state.error) && (
              <span className="block text-[12px] opacity-80">{assistErrorDetail(state.error)}</span>
            )}
          </span>
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={ask}>
            {t("assist.retry")}
          </Button>
        </div>
      )}

      {result && (
        <>
          {result.verdicts.length === 0 ? (
            <p className="text-[13px] text-muted">{t("assist.labelAgain.noLabels")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {result.verdicts.map((verdict) => {
                const entry = entries.find((each) => each.label.id === verdict.labelId);
                const on = entry ? hasLabel(message, labelRef(entry)) : verdict.isSet;
                const checked = choice[verdict.labelId] ?? verdict.fits;
                return (
                  <li key={verdict.labelId}>
                    <label className="flex cursor-pointer items-start gap-2.5 rounded-xl px-2 py-1.5 hover:bg-pink-tint/40">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!entry || busy !== null}
                        onChange={(event) => setChoice({ ...choice, [verdict.labelId]: event.target.checked })}
                        className="mt-0.5 size-4 shrink-0 accent-pink"
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span
                            style={chipStyle(entry?.label.color ?? null)}
                            className="inline-flex h-5 items-center rounded-full border border-line px-2 text-[11.5px] font-semibold"
                          >
                            {entry?.label.name ?? verdict.name}
                          </span>
                          <span
                            className={clsx(
                              "text-[11px] font-bold tracking-wide uppercase",
                              verdict.fits ? "text-success" : "text-muted",
                            )}
                          >
                            {verdict.fits ? t("assist.labelAgain.fits") : t("assist.labelAgain.fitsNot")}
                          </span>
                          {on && <span className="text-[11px] text-faint">{t("assist.labelAgain.isSet")}</span>}
                          {entry && checked !== on && (
                            <span className="text-[11px] font-semibold text-pink-ink">
                              {checked ? t("assist.labelAgain.willAdd") : t("assist.labelAgain.willRemove")}
                            </span>
                          )}
                        </span>
                        {verdict.reason && <span className="text-[12.5px] break-words">{verdict.reason}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {result.newLabels.length > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-hairline pt-3">
              <p className="text-[12px] font-bold tracking-wide text-muted uppercase">
                {t("assist.labelAgain.newTitle")}
              </p>
              <ul className="flex flex-col gap-1.5">
                {result.newLabels.map((proposal, index) => {
                  const done = made.includes(proposal.name);
                  return (
                    <li key={proposal.name} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-2 py-1">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span
                          style={chipStyle(proposal.color)}
                          className="inline-flex h-5 items-center self-start rounded-full border border-line px-2 text-[11.5px] font-semibold"
                        >
                          {proposal.name}
                        </span>
                        {proposal.description && <span className="text-[12px] text-muted">{proposal.description}</span>}
                        {proposal.reason && <span className="text-[12.5px] break-words">{proposal.reason}</span>}
                      </span>
                      <Button
                        size="sm"
                        icon={done ? Check : Plus}
                        disabled={done || !scope || (busy !== null && busy !== `new:${index}`)}
                        busy={busy === `new:${index}`}
                        onClick={() => void create(proposal, index)}
                      >
                        {done ? t("assist.labelAgain.created") : t("assist.labelAgain.create")}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <footer className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
            <p className="min-w-[min(100%,12rem)] flex-1 text-[12px] text-muted">{t("assist.labelAgain.decide")}</p>
            <Button
              size="sm"
              variant="primary"
              icon={Check}
              disabled={changeCount === 0 || (busy !== null && busy !== "apply")}
              busy={busy === "apply"}
              onClick={() => void apply()}
            >
              {changeCount === 0
                ? t("assist.labelAgain.nothing")
                : t("assist.labelAgain.apply", { count: changeCount })}
            </Button>
          </footer>
          <p className="-mt-1 text-[11.5px] text-muted sm:hidden">{providerLabel(result)}</p>
        </>
      )}
    </section>
  );
}
