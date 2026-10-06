import clsx from "clsx";
import { Button, Icon, IconButton, type IconProps, ICONS, Menu } from "@uwusuite/design";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { NyuThinking } from "@/components/nyu/NyuThinking";
import { backend } from "@/backend/backend";
import { withAiConsent } from "./consent";
import { ASSIST_PRESETS, type AssistComposeRequest, type AssistPreset } from "@/backend/types";
import { useT } from "@/i18n";
import { EstimateLabel, EstimateTip, type EstimateRequest, useSettled } from "./estimate";
import {
  assistErrorDetail,
  assistErrorText,
  providerLabel,
  useAssistAccount,
  useAssistOptions,
  useAssistSettings,
  useAssistStream,
} from "./useAssist";

/** What the assistant was asked for from the composer's menu. */
export type ComposeAssistStart = { kind: "write" } | { kind: "rewrite"; preset: AssistPreset } | { kind: "adjust" };

/** What the draft gives the assistant, taken when the menu item was picked. */
export interface ComposeAssistContext {
  /** The marked text, or the person's own part of the draft (without signature and quote). */
  source: { scope: "selection" | "own"; text: string };
  subject: string;
  /** The mail being answered, as context. */
  replyToEmailId: string | null;
  /** The UI language, as a hint. */
  language: string;
}

/** Languages offered for translating, as tags; their names come from the browser. */
const TARGET_LANGUAGES = ["en", "de", "fr", "nl", "es", "it", "pt", "pl", "tr", "uk", "ja", "zh"];

/** The language a translation goes to first: English, or German for someone who reads English. */
export function firstTargetLanguage(language: string): string {
  return language === "en" ? "de" : "en";
}

/** What the panel asks the assistant, from what is typed and picked there. */
export function composeRequest(
  ask: { mode: AssistComposeRequest["mode"]; preset: AssistPreset | null; base: string },
  typed: { instruction: string; targetLanguage: string; wantSubject: boolean },
  context: ComposeAssistContext,
): AssistComposeRequest {
  return {
    mode: ask.mode,
    instruction: typed.instruction.trim() || null,
    preset: ask.mode === "rewrite" ? ask.preset : null,
    targetLanguage: ask.preset === "translate" ? typed.targetLanguage : null,
    text: ask.mode === "write" ? null : ask.base,
    subject: context.subject || null,
    replyToEmailId: context.replyToEmailId,
    wantSubject: ask.mode === "write" && typed.wantSubject,
    language: context.language,
  };
}

/**
 * The estimate of a menu item, before anything is typed: the instruction still to come counts as
 * a word, the rest is what the panel would send.
 */
export function composeEstimate(
  accountId: string,
  start: ComposeAssistStart,
  context: ComposeAssistContext,
): EstimateRequest {
  const mode = start.kind === "write" ? "write" : start.kind === "adjust" ? "adjust" : "rewrite";
  const request = composeRequest(
    { mode, preset: start.kind === "rewrite" ? start.preset : null, base: context.source.text },
    {
      instruction: mode === "rewrite" ? "" : "…",
      targetLanguage: firstTargetLanguage(context.language),
      wantSubject: mode === "write" && !context.subject,
    },
    context,
  );
  return { accountId, method: "Assist/compose", args: { ...request } };
}

/** The ✨ button in the composer's toolbar with what the assistant can do there. */
export function ComposeAssistButton({
  onPick,
  estimate,
}: {
  onPick: (start: ComposeAssistStart) => void;
  /** The call an item would make, read from the draft when its tooltip is wanted. */
  estimate?: (start: ComposeAssistStart) => EstimateRequest | null;
}) {
  const { t } = useT();
  const label = (start: ComposeAssistStart, icon: IconProps["icon"], text: string) => {
    const content = <MenuLabel icon={icon} text={text} />;
    return estimate ? <EstimateLabel request={() => estimate(start)}>{content}</EstimateLabel> : content;
  };
  return (
    <Menu
      side="above"
      align="end"
      items={[
        {
          label: label({ kind: "write" }, ICONS.ai, t("assist.compose.write")),
          onSelect: () => onPick({ kind: "write" }),
        },
        { heading: t("assist.compose.rewriteGroup") },
        ...ASSIST_PRESETS.map((preset) => ({
          label: label(
            { kind: "rewrite", preset },
            preset === "translate" ? ICONS.language : preset === "proofread" ? ICONS.proofread : ICONS.rewrite,
            t(`assist.preset.${preset}`),
          ),
          onSelect: () => onPick({ kind: "rewrite", preset }),
        })),
        { heading: t("assist.compose.moreGroup") },
        {
          label: label({ kind: "adjust" }, ICONS.adjust, t("assist.compose.adjust")),
          onSelect: () => onPick({ kind: "adjust" }),
        },
      ]}
      trigger={(menu) => (
        <IconButton
          icon={ICONS.ai}
          size="sm"
          label={t("assist.compose.button")}
          // The cursor and the marked text in the draft stay where they are.
          onMouseDown={(event) => event.preventDefault()}
          onClick={menu.toggle}
          aria-haspopup={menu["aria-haspopup"]}
          aria-expanded={menu["aria-expanded"]}
          aria-controls={menu["aria-controls"]}
        />
      )}
    />
  );
}

function MenuLabel({ icon: Glyph, text }: { icon: IconProps["icon"]; text: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <Icon icon={Glyph} className="shrink-0 text-muted" />
      {text}
    </span>
  );
}

interface PanelProps {
  start: ComposeAssistStart;
  context: ComposeAssistContext;
  /** The draft has no subject yet: a proposed one can be taken. */
  subjectEmpty: boolean;
  onInsert: (text: string) => void;
  onReplace: (text: string) => void;
  onSubject: (subject: string) => void;
  onClose: () => void;
}

/** What is asked: the mode, and for adjusting the text it starts from. */
interface Ask {
  mode: AssistComposeRequest["mode"];
  preset: AssistPreset | null;
  /** The text to rewrite or adjust. */
  base: string;
}

/**
 * The assistant's answer inside the composer: it streams into this panel, never into the draft,
 * and goes there only with "Insert" or "Replace".
 */
export function ComposeAssistPanel({
  start,
  context,
  subjectEmpty,
  onInsert,
  onReplace,
  onSubject,
  onClose,
}: PanelProps) {
  const { t } = useT();
  const { data: options } = useAssistOptions();
  const { data: settings } = useAssistSettings();
  const accountId = useAssistAccount();
  const { state, run, stop, reset } = useAssistStream();
  const [ask, setAsk] = useState<Ask>(() => ({
    mode: start.kind === "write" ? "write" : start.kind === "adjust" ? "adjust" : "rewrite",
    preset: start.kind === "rewrite" ? start.preset : null,
    base: context.source.text,
  }));
  const needsInput = ask.mode !== "rewrite" || ask.preset === "translate";
  const [asking, setAsking] = useState(needsInput);
  const [instruction, setInstruction] = useState("");
  const [targetLanguage, setTargetLanguage] = useState(() => firstTargetLanguage(context.language));
  const [wantSubject, setWantSubject] = useState(subjectEmpty);
  const [subjectTaken, setSubjectTaken] = useState(false);
  const [lastRequest, setLastRequest] = useState<AssistComposeRequest | null>(null);
  const inputId = useId();
  const maxText = options?.maxTextChars ?? 20000;
  const maxInstruction = options?.maxInstructionChars ?? 2000;
  const languageNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([context.language], { type: "language" });
    } catch {
      return null;
    }
  }, [context.language]);

  const tooLong = ask.mode !== "write" && ask.base.length > maxText;
  const nothingToRewrite = ask.mode !== "write" && ask.base.trim() === "";

  const send = (request: AssistComposeRequest) => {
    setLastRequest(request);
    setAsking(false);
    setSubjectTaken(false);
    void run(
      (handlers) => withAiConsent(["compose"], () => backend().assistCompose(accountId ?? "", request, handlers)),
      (answer) => ({ text: answer.text, subject: answer.subject }),
    );
  };

  const request = (): AssistComposeRequest =>
    composeRequest(ask, { instruction, targetLanguage, wantSubject }, context);
  // The send button's estimate follows the instruction once typing pauses.
  const settledInstruction = useSettled(instruction);
  const estimate: EstimateRequest | null =
    accountId && (settledInstruction.trim() || ask.preset === "translate")
      ? {
          accountId,
          method: "Assist/compose",
          args: { ...composeRequest(ask, { instruction: settledInstruction, targetLanguage, wantSubject }, context) },
        }
      : null;

  // A preset needs nothing more: it starts at once (a tick later, so a mount that is undone at
  // once, as in React's strict mode, asks only once).
  useEffect(() => {
    if (needsInput || nothingToRewrite || tooLong) return;
    const timer = setTimeout(() => send(request()), 0);
    return () => clearTimeout(timer);
    // Only for the preset the panel opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ((ask.mode === "write" || ask.mode === "adjust") && !instruction.trim()) return;
    send(request());
  };

  /** Changes the answer further: it becomes the text the next instruction works on. */
  const adjustFurther = () => {
    setAsk({ mode: "adjust", preset: null, base: state.text });
    setInstruction("");
    reset();
    setAsking(true);
  };

  const title =
    ask.mode === "write"
      ? t("assist.compose.write")
      : ask.mode === "adjust"
        ? t("assist.compose.adjust")
        : t("assist.compose.rewriteTitle", { preset: t(`assist.preset.${ask.preset ?? "clearer"}`) });
  const used = state.answer ?? settings?.effective.compose ?? null;
  const working = state.status === "working";
  const hasText = state.text.trim() !== "";
  const fromSelection = context.source.scope === "selection";

  return (
    <section
      aria-label={title}
      // Keys typed here are the panel's: Escape must not shrink the composer, Enter not send it.
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) event.stopPropagation();
      }}
      className="mx-3 mb-2 flex max-h-[48%] min-h-0 shrink-0 animate-fade flex-col overflow-hidden rounded-2xl border border-pink/30 bg-pink-tint/35 shadow-[0_4px_18px_rgb(225_29_116/0.08)]"
    >
      <header className="flex items-center gap-2 px-3.5 pt-2.5 pb-1.5">
        <Icon icon={ICONS.ai} className="shrink-0 text-pink" />
        <h3 className="min-w-0 truncate text-[13.5px] font-bold">{title}</h3>
        {used && (
          <span
            className="ml-auto min-w-0 truncate rounded-full bg-surface/80 px-2 py-0.5 text-[11.5px] font-semibold text-muted"
            title={t("assist.usedProvider", { provider: providerLabel(used) })}
          >
            {providerLabel(used)}
          </span>
        )}
        <IconButton
          icon={ICONS.close}
          size="sm"
          label={t("assist.compose.discard")}
          onClick={onClose}
          className={clsx(!used && "ml-auto")}
        />
      </header>

      <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto px-3.5 pb-3">
        <p className="flex items-start gap-1.5 text-[12px] text-muted">
          <Icon icon={ICONS.info} size="xs" className="mt-px shrink-0" />
          <span>
            {ask.mode === "write"
              ? context.replyToEmailId
                ? t("assist.compose.scopeReply")
                : t("assist.compose.scopeNew")
              : fromSelection
                ? t("assist.compose.scopeSelection")
                : t("assist.compose.scopeOwn")}
          </span>
        </p>

        {nothingToRewrite && <Note tone="warning">{t("assist.compose.nothingToRewrite")}</Note>}
        {tooLong && <Note tone="warning">{t("assist.compose.tooLong", { count: maxText })}</Note>}

        {asking && !nothingToRewrite && !tooLong && (
          <form onSubmit={submit} className="flex flex-col gap-2">
            {ask.preset === "translate" ? (
              <label htmlFor={inputId} className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
                {t("assist.compose.translateTo")}
                <select
                  id={inputId}
                  value={targetLanguage}
                  onChange={(event) => setTargetLanguage(event.target.value)}
                  className="h-9 rounded-control border border-line bg-surface px-3 text-[13.5px] font-normal focus:border-pink focus:shadow-focus focus:outline-none"
                >
                  {TARGET_LANGUAGES.map((tag) => (
                    <option key={tag} value={tag}>
                      {languageNames?.of(tag) ?? tag}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label htmlFor={inputId} className="sr-only">
                  {t("assist.compose.instruction")}
                </label>
                <textarea
                  id={inputId}
                  autoFocus
                  rows={2}
                  maxLength={maxInstruction}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    ask.mode === "write"
                      ? context.replyToEmailId
                        ? t("assist.compose.replyPlaceholder")
                        : t("assist.compose.writePlaceholder")
                      : t("assist.compose.adjustPlaceholder")
                  }
                  className="w-full resize-none rounded-xl border border-line bg-surface px-3 py-2 text-[13.5px] placeholder:text-faint focus:border-pink focus:shadow-focus focus:outline-none"
                />
              </>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {ask.mode === "write" && subjectEmpty && (
                <label className="flex items-center gap-1.5 text-[12.5px] text-muted">
                  <input
                    type="checkbox"
                    checked={wantSubject}
                    onChange={(event) => setWantSubject(event.target.checked)}
                    className="size-3.5 accent-pink"
                  />
                  {t("assist.compose.wantSubject")}
                </label>
              )}
              <EstimateTip request={estimate} className="ml-auto">
                <Button
                  type="submit"
                  size="sm"
                  variant="primary"
                  icon={ICONS.ai}
                  disabled={ask.preset !== "translate" && !instruction.trim()}
                >
                  {ask.mode === "write"
                    ? t("assist.compose.go")
                    : ask.preset === "translate"
                      ? t("assist.compose.translate")
                      : t("assist.compose.apply")}
                </Button>
              </EstimateTip>
            </div>
          </form>
        )}

        {!asking && (state.status !== "idle" || hasText) && (
          <div className="flex flex-col gap-2">
            {state.subject && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface px-3 py-2 text-[13px]">
                <span className="font-semibold text-muted">{t("compose.subject")}:</span>
                <span className="selectable min-w-0 flex-1 font-semibold break-words">{state.subject}</span>
                {!working && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={subjectTaken ? ICONS.done : undefined}
                    disabled={subjectTaken}
                    onClick={() => {
                      onSubject(state.subject!);
                      setSubjectTaken(true);
                    }}
                  >
                    {subjectTaken ? t("assist.compose.subjectTaken") : t("assist.compose.takeSubject")}
                  </Button>
                )}
              </div>
            )}
            <div
              role="status"
              aria-live="polite"
              aria-busy={working}
              className="selectable max-h-72 min-h-[3.5rem] overflow-y-auto rounded-xl bg-surface px-3 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap"
            >
              {hasText ? state.text : working ? <Thinking /> : null}
              {working && hasText && <Caret />}
            </div>
            {state.status === "error" && (
              <Note tone="danger">
                {assistErrorText(state.error)}
                {assistErrorDetail(state.error) && (
                  <span className="mt-0.5 block text-[12px] opacity-80">{assistErrorDetail(state.error)}</span>
                )}
              </Note>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {working ? (
                <Button size="sm" icon={ICONS.stop} onClick={stop}>
                  {t("assist.stop")}
                </Button>
              ) : (
                <>
                  {hasText && (
                    <>
                      <Button
                        size="sm"
                        variant={ask.mode === "write" ? "primary" : "secondary"}
                        icon={ICONS.insert}
                        onClick={() => onInsert(state.text)}
                      >
                        {t("assist.compose.insert")}
                      </Button>
                      <Button
                        size="sm"
                        variant={ask.mode === "write" ? "secondary" : "primary"}
                        icon={ICONS.replace}
                        onClick={() => onReplace(state.text)}
                        title={
                          fromSelection ? t("assist.compose.replaceSelectionHint") : t("assist.compose.replaceOwnHint")
                        }
                      >
                        {fromSelection ? t("assist.compose.replaceSelection") : t("assist.compose.replace")}
                      </Button>
                    </>
                  )}
                  {lastRequest && (
                    <Button size="sm" variant="ghost" icon={ICONS.refresh} onClick={() => send(lastRequest)}>
                      {t("assist.retry")}
                    </Button>
                  )}
                  {hasText && (
                    <Button size="sm" variant="ghost" icon={ICONS.adjust} onClick={adjustFurther}>
                      {t("assist.compose.adjustFurther")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        <p className="text-[11.5px] text-faint">{t("assist.compose.reviewNote")}</p>
      </div>
    </section>
  );
}

function Note({ tone, children }: { tone: "warning" | "danger"; children: ReactNode }) {
  return (
    <p
      role={tone === "danger" ? "alert" : undefined}
      className={clsx(
        "rounded-xl px-3 py-2 text-[13px] font-medium",
        tone === "danger" ? "bg-danger-tint text-danger-ink" : "bg-warning-tint text-warning-ink",
      )}
    >
      {children}
    </p>
  );
}

/** The model is thinking: Nyu ponders, or three soft dots while Nyu's animations are off. */
export function Thinking() {
  const { t } = useT();
  const dots = (
    <span className="inline-flex gap-1" aria-hidden>
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="size-1.5 animate-pulse rounded-full bg-pink"
          style={{ animationDelay: `${dot * 180}ms` }}
        />
      ))}
    </span>
  );
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-muted">
      <NyuThinking fallback={dots} className="-my-1.5" />
      {t("assist.thinking")}
    </span>
  );
}

/** Where the text grows while the model writes. */
export function Caret() {
  return (
    <span className="ml-0.5 inline-block h-[1.05em] w-[2px] animate-pulse bg-pink align-text-bottom" aria-hidden />
  );
}
