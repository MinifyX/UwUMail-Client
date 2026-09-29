import clsx from "clsx";
import { ChevronDown, RotateCcw, Sparkles, Square, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { backend } from "@/backend/backend";
import { Button, IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { Caret, Thinking } from "./ComposeAssist";
import { mailKey, summaryParts, threadKey, useAssistReader } from "./readerState";
import { assistErrorDetail, assistErrorText, providerLabel, useAssistSettings, useAssistStream } from "./useAssist";

interface SummaryCardProps {
  kind: "mail" | "thread";
  /** The mail's id, or the conversation's thread id. */
  id: string;
  /** How many mails the conversation has, for the heading. */
  count?: number;
}

/**
 * A summary of one mail or a whole conversation, above it. It streams in, can be folded away,
 * and says which provider and model wrote it. A finished one stays for the session.
 */
export function SummaryCard({ kind, id, count }: SummaryCardProps) {
  const { t, i18n } = useT();
  const key = kind === "mail" ? mailKey(id) : threadKey(id);
  const saved = useAssistReader((s) => s.done[key]);
  const hide = useAssistReader((s) => s.hideSummary);
  const remember = useAssistReader((s) => s.remember);
  const { state, run, stop } = useAssistStream();
  const { data: settings } = useAssistSettings();
  const [open, setOpen] = useState(true);
  const bodyId = useId();

  const summarize = () =>
    void run(
      (handlers) =>
        backend().assistSummarize(
          kind === "mail" ? { emailId: id, language: i18n.language } : { threadId: id, language: i18n.language },
          handlers,
        ),
      (answer) => {
        remember(key, answer.summary, answer);
        return { text: answer.summary };
      },
    );

  // When the card appears: a summary kept from before is shown instead of asking again. Started
  // a tick later, so a mount that is undone at once (React's strict mode) asks only once.
  useEffect(() => {
    if (saved) return;
    const timer = setTimeout(summarize, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fresh = state.status !== "idle";
  const text = fresh ? state.text : (saved?.text ?? "");
  const answer = fresh ? state.answer : (saved?.answer ?? null);
  const working = state.status === "working";
  const { lead, points } = summaryParts(text);
  const used = answer ?? (working ? settings?.effective.summarize : null);

  return (
    <section
      aria-label={kind === "mail" ? t("assist.summary.mail") : t("assist.summary.thread")}
      className="flex animate-fade flex-col rounded-[18px] border border-pink/25 bg-gradient-to-br from-pink-tint/60 to-surface px-4 py-3"
    >
      <header className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left focus-visible:shadow-focus focus-visible:outline-none"
        >
          <Sparkles className="size-4 shrink-0 text-pink" aria-hidden />
          <span className="truncate text-[13.5px] font-bold">
            {kind === "mail" ? t("assist.summary.mail") : t("assist.summary.threadCount", { count: count ?? 0 })}
          </span>
          <ChevronDown
            className={clsx("size-4 shrink-0 text-muted transition-transform", !open && "-rotate-90")}
            aria-hidden
          />
        </button>
        {used && (
          <span className="hidden min-w-0 truncate text-[11.5px] font-semibold text-muted sm:inline">
            {providerLabel(used)}
          </span>
        )}
        {working ? (
          <IconButton icon={Square} size="sm" label={t("assist.stop")} onClick={stop} />
        ) : (
          <IconButton icon={RotateCcw} size="sm" label={t("assist.summary.again")} onClick={summarize} />
        )}
        <IconButton icon={X} size="sm" label={t("assist.summary.close")} onClick={() => hide(key)} />
      </header>
      {open && (
        <div id={bodyId} role="status" aria-live="polite" aria-busy={working} className="selectable pt-2 text-[13.5px]">
          {!text && working && <Thinking />}
          {lead.length > 0 && <p className="leading-relaxed">{lead.join(" ")}</p>}
          {points.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-1 pl-1">
              {points.map((point, index) => (
                <li key={index} className="flex gap-2 leading-snug">
                  <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-pink" aria-hidden />
                  <span className="min-w-0">{point}</span>
                </li>
              ))}
            </ul>
          )}
          {working && text && <Caret />}
          {state.status === "error" && (
            <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-danger">
              <span className="min-w-0 flex-1">
                {assistErrorText(state.error)}
                {assistErrorDetail(state.error) && (
                  <span className="block text-[12px] opacity-80">{assistErrorDetail(state.error)}</span>
                )}
              </span>
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={summarize}>
                {t("assist.retry")}
              </Button>
            </div>
          )}
          {used && <p className="pt-2 text-[11.5px] text-muted sm:hidden">{providerLabel(used)}</p>}
        </div>
      )}
    </section>
  );
}
