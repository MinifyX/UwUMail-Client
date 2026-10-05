import clsx from "clsx";
import {
  BookUser,
  Bot,
  ClipboardList,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  Gauge,
  Inbox,
  KeyRound,
  Mail,
  Quote,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { backend } from "@/backend/backend";
import type { AssistSpamCheck, AssistSpamFacts, AssistVerdict, Message } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { formatLongDate } from "@/lib/format";
import { useMessageActions } from "@/lib/queries";
import { useUi } from "@/state/ui";
import { Thinking } from "./ComposeAssist";
import { authTone, certainty, percent, scoreShare, useAssistReader, type SignalTone } from "./readerState";
import { assistErrorDetail, assistErrorText, isAbort, providerLabel } from "./useAssist";

const VERDICT_LOOK: Record<AssistVerdict, { icon: LucideIcon; className: string; bar: string }> = {
  legitimate: { icon: ShieldCheck, className: "bg-success-tint text-success", bar: "bg-success" },
  suspicious: { icon: ShieldQuestion, className: "bg-warning-tint text-warning", bar: "bg-warning" },
  spam: { icon: ShieldAlert, className: "bg-danger-tint text-danger", bar: "bg-danger" },
  phishing: { icon: ShieldAlert, className: "bg-danger text-white", bar: "bg-danger" },
};

const TONE_LOOK: Record<SignalTone, { icon: LucideIcon; className: string }> = {
  good: { icon: CircleCheck, className: "text-success" },
  bad: { icon: CircleX, className: "text-danger" },
  neutral: { icon: CircleHelp, className: "text-muted" },
};

interface SpamCheckCardProps {
  message: Message;
  /** The mail lies in Junk now. */
  inJunk: boolean;
}

/**
 * A second opinion on a mail: the facts the server weighed first (they set the range of verdicts),
 * the model's verdict and reasons with what each rests on, what the server itself found
 * (authentication, spam score, the sender's history), and the usual "Spam" / "Not spam" to decide
 * with. The model decides nothing.
 */
export function SpamCheckCard({ message, inJunk }: SpamCheckCardProps) {
  const { t, i18n } = useT();
  const saved = useAssistReader((s) => s.spamResults[message.id]);
  const remember = useAssistReader((s) => s.rememberSpamCheck);
  const hide = useAssistReader((s) => s.hideSpamCheck);
  const actions = useMessageActions();
  const [state, setState] = useState<{ working: boolean; error: unknown }>({ working: !saved, error: null });
  const controller = useRef<AbortController | null>(null);

  const check = () => {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setState({ working: true, error: null });
    backend()
      .assistSpamCheck(message.id, i18n.language)
      .then((result) => {
        if (own.signal.aborted) return;
        remember(result);
        setState({ working: false, error: null });
      })
      .catch((error: unknown) => {
        if (own.signal.aborted || isAbort(error)) return;
        setState({ working: false, error });
      });
  };

  // When the card appears; a check kept from before is shown instead of asking again. Started a
  // tick later, so a mount that is undone at once (React's strict mode) asks only once.
  useEffect(() => {
    const timer = saved ? undefined : setTimeout(check, 0);
    return () => {
      clearTimeout(timer);
      controller.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const report = (spam: boolean) => {
    void actions.spam([message.id], spam).then(() => {
      if (spam || inJunk) useUi.getState().selectThread(null);
    });
    hide(message.id);
  };

  return (
    <section
      aria-label={t("assist.spam.title")}
      className="flex animate-fade flex-col gap-3 rounded-[18px] border border-line bg-canvas px-4 py-3"
    >
      <header className="flex items-center gap-2">
        <ShieldQuestion className="size-4 shrink-0 text-pink" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-[13.5px] font-bold">{t("assist.spam.title")}</h3>
        {saved && !state.working && (
          <span className="hidden min-w-0 truncate text-[11.5px] font-semibold text-muted sm:inline">
            {providerLabel(saved)}
          </span>
        )}
        {!state.working && <IconButton icon={RotateCcw} size="sm" label={t("assist.spam.again")} onClick={check} />}
        <IconButton icon={X} size="sm" label={t("assist.spam.close")} onClick={() => hide(message.id)} />
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
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={check}>
            {t("assist.retry")}
          </Button>
        </div>
      )}
      {!state.working && state.error === null && saved && <Verdict result={saved} />}
      {!state.working && state.error === null && saved?.facts && <Facts facts={saved.facts} language={i18n.language} />}
      {!state.working && state.error === null && saved && <Signals result={saved} language={i18n.language} />}

      <footer className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
        <p className="min-w-[min(100%,12rem)] flex-1 text-[12px] text-muted">{t("assist.spam.decide")}</p>
        <Button
          size="sm"
          variant={
            saved && (saved.verdict === "spam" || saved.verdict === "phishing") && !inJunk ? "primary" : "secondary"
          }
          icon={ShieldAlert}
          disabled={inJunk}
          onClick={() => report(true)}
        >
          {t("reader.spam")}
        </Button>
        <Button
          size="sm"
          variant={saved?.verdict === "legitimate" && inJunk ? "primary" : "secondary"}
          icon={ShieldCheck}
          onClick={() => report(false)}
        >
          {t("reader.notSpam")}
        </Button>
      </footer>
      {saved && !state.working && <p className="-mt-1 text-[11.5px] text-muted sm:hidden">{providerLabel(saved)}</p>}
    </section>
  );
}

function Verdict({ result }: { result: AssistSpamCheck }) {
  const { t } = useT();
  const look = VERDICT_LOOK[result.verdict];
  const Icon = look.icon;
  const share = percent(result.confidence);
  const sure = t(`assist.spam.certainty.${certainty(result.confidence)}`);
  // Older servers send the reasons only as text.
  const reasons =
    result.reasonDetails.length > 0
      ? result.reasonDetails
      : result.reasons.map((text) => ({ text, quote: null, fact: null }));
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13.5px] font-extrabold",
            look.className,
          )}
        >
          <Icon className="size-4" aria-hidden />
          {t(`assist.spam.verdict.${result.verdict}`)}
        </span>
        <span className="flex min-w-[9rem] flex-1 items-center gap-2 text-[12px] text-muted">
          <span
            className="h-1.5 max-w-40 flex-1 overflow-hidden rounded-full bg-line"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share}
            aria-valuetext={sure}
            aria-label={t("assist.spam.confidenceLabel")}
          >
            <span className={clsx("block h-full rounded-full", look.bar)} style={{ width: `${share}%` }} />
          </span>
          {sure}
        </span>
      </div>
      <p className="text-[12.5px] text-muted">{t(`assist.spam.verdictHint.${result.verdict}`)}</p>
      {result.modelVerdict && result.modelVerdict !== result.verdict && (
        <p className="rounded-xl bg-surface px-3 py-2 text-[12.5px] text-muted">
          {t("assist.spam.modelVerdict", { verdict: t(`assist.spam.verdict.${result.modelVerdict}`) })}
        </p>
      )}
      {reasons.length > 0 && (
        // The model's own words, kept apart from what the server found: they are not checked facts.
        <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-line px-3 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-wide text-muted uppercase">
            <Bot className="size-3.5" aria-hidden />
            <span>{t("assist.spam.modelWordsTitle")}</span>
          </p>
          <p className="text-[11.5px] text-muted">{t("assist.spam.modelWordsHint")}</p>
          <ul className="selectable flex flex-col gap-1.5 text-[13.5px]" aria-label={t("assist.spam.modelWordsTitle")}>
            {reasons.map((reason, index) => (
              <li key={index} className="flex gap-2 leading-snug">
                <span className={clsx("mt-[7px] size-1.5 shrink-0 rounded-full", look.bar)} aria-hidden />
                <span className="min-w-0">
                  {reason.text}
                  {reason.quote ? (
                    <span className="mt-0.5 flex items-start gap-1 text-[12px] text-muted">
                      <Quote className="mt-0.5 size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 break-words italic">
                        <QuotedIn text={t("assist.spam.reasonQuote", { quote: QUOTE_SLOT })} quote={reason.quote} />
                      </span>
                    </span>
                  ) : (
                    reason.fact && (
                      <span className="mt-0.5 block text-[12px] text-muted">{t("assist.spam.reasonFact")}</span>
                    )
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.droppedReasons > 0 && (
        <p className="text-[12px] text-muted">{t("assist.spam.dropped", { count: result.droppedReasons })}</p>
      )}
    </div>
  );
}

/** What the server weighed before the model said a word, strongest first. */
function Facts({ facts, language }: { facts: AssistSpamFacts; language: string }) {
  const { t } = useT();
  const points = new Intl.NumberFormat(language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  });
  const evidence = [...facts.evidence].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const bad = facts.band === "leaningSpam" || facts.band === "spam";
  const good = facts.band === "clean" || facts.band === "leaningClean";
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-bold tracking-wide text-muted uppercase">
        <ClipboardList className="size-3.5" aria-hidden />
        <span>{t("assist.spam.factsTitle")}</span>
        <span
          className={clsx(
            "rounded-full px-2 py-px text-[11px] font-bold tracking-normal normal-case",
            bad ? "bg-danger-tint text-danger" : good ? "bg-success-tint text-success" : "bg-warning-tint text-warning",
          )}
        >
          {t(`assist.spam.band.${facts.band}`)} · {t("assist.spam.factsScore", { score: points.format(facts.score) })}
        </span>
      </p>
      {evidence.length > 0 && (
        <ul className="flex flex-col gap-1 text-[12.5px]" aria-label={t("assist.spam.factsTitle")}>
          {evidence.map((item) => {
            const look = TONE_LOOK[item.tone];
            const Icon = look.icon;
            return (
              <li key={item.code} className="flex min-w-0 items-start gap-2 rounded-xl bg-surface px-3 py-1.5">
                <Icon className={clsx("mt-0.5 size-3.5 shrink-0", look.className)} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block">{t(`assist.spam.evidence.${item.code}`, { defaultValue: item.code })}</span>
                  {item.detail && (
                    <span className="selectable block font-mono text-[11px] break-all text-muted">
                      {/* Mail text: its direction marks stay inside (WF-2). */}
                      <bdi>{item.detail}</bdi>
                    </span>
                  )}
                </span>
                <span className={clsx("shrink-0 font-mono text-[11px] font-semibold", look.className)}>
                  {points.format(item.weight)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Signals({ result, language }: { result: AssistSpamCheck; language: string }) {
  const { t } = useT();
  const { authentication: auth, sender } = result.signals;
  const noAuth = auth.spf === null && auth.dkim === null && auth.dmarc === null;
  const share = scoreShare(result.signals.spamScore, result.signals.spamThreshold);
  const points = new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const over = share !== null && share >= 1;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-bold tracking-wide text-muted uppercase">{t("assist.spam.serverTitle")}</p>
      <dl className="grid gap-2 text-[12.5px] sm:grid-cols-2">
        <Signal icon={KeyRound} label={t("assist.spam.auth")}>
          {noAuth ? (
            <span className="text-muted">{t("assist.spam.authNone")}</span>
          ) : (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              {(["spf", "dkim", "dmarc"] as const).map((name) => (
                <AuthResult key={name} name={name.toUpperCase()} value={auth[name]} />
              ))}
            </span>
          )}
          {auth.fromDomain && (
            <span className="block text-[11.5px] text-muted">
              {t("assist.spam.fromDomain", { domain: auth.fromDomain })}
            </span>
          )}
        </Signal>
        <Signal icon={Gauge} label={t("assist.spam.score")}>
          {result.signals.spamScore === null ? (
            <span className="text-muted">{t("assist.spam.scoreNone")}</span>
          ) : (
            <>
              <span className={clsx("font-semibold", over && "text-danger")}>
                {result.signals.spamThreshold === null
                  ? t("assist.spam.scoreOnly", { score: points.format(result.signals.spamScore) })
                  : t("assist.spam.scoreOf", {
                      score: points.format(result.signals.spamScore),
                      threshold: points.format(result.signals.spamThreshold),
                    })}
              </span>
              {share !== null && (
                <span className="mt-1 block h-1.5 max-w-48 overflow-hidden rounded-full bg-line" aria-hidden>
                  <span
                    className={clsx(
                      "block h-full rounded-full",
                      over ? "bg-danger" : share > 0.6 ? "bg-warning" : "bg-success",
                    )}
                    style={{ width: `${Math.round(share * 100)}%` }}
                  />
                </span>
              )}
            </>
          )}
          {result.signals.tests.length > 0 && (
            <span className="mt-1 flex flex-wrap gap-1" aria-label={t("assist.spam.tests")}>
              {result.signals.tests.slice(0, 12).map((test) => (
                <code key={test} className="rounded-md bg-surface px-1.5 py-px font-mono text-[10.5px] text-muted">
                  {test}
                </code>
              ))}
              {result.signals.tests.length > 12 && (
                <span className="text-[11px] text-muted">+{result.signals.tests.length - 12}</span>
              )}
            </span>
          )}
        </Signal>
        <Signal icon={Inbox} label={t("assist.spam.folder")}>
          {result.signals.inJunk ? t("assist.spam.inJunk") : t("assist.spam.notInJunk")}
        </Signal>
        <Signal icon={Mail} label={t("assist.spam.sender")}>
          <span className="selectable block break-all">{sender.address}</span>
          <span className="block text-muted">
            {sender.earlierMessages === 0
              ? t("assist.spam.firstMail")
              : sender.earlierInJunk > 0
                ? t("assist.spam.earlierWithJunk", { count: sender.earlierMessages, junk: sender.earlierInJunk })
                : t("assist.spam.earlier", { count: sender.earlierMessages })}
          </span>
        </Signal>
        <Signal icon={Send} label={t("assist.spam.writtenToLabel")}>
          {sender.writtenTo === 0
            ? t("assist.spam.neverWritten")
            : t("assist.spam.writtenTo", { count: sender.writtenTo })}
        </Signal>
        <Signal icon={BookUser} label={t("assist.spam.contactsLabel")}>
          {sender.inContacts ? t("assist.spam.inContacts") : t("assist.spam.notInContacts")}
        </Signal>
        {sender.firstSeen && (
          <Signal icon={Clock} label={t("assist.spam.firstSeen")}>
            {formatLongDate(sender.firstSeen, language)}
          </Signal>
        )}
      </dl>
    </div>
  );
}

function Signal({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 rounded-xl bg-surface px-3 py-2">
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1">
        <dt className="text-[11px] font-semibold text-muted">{label}</dt>
        <dd className="min-w-0">{children}</dd>
      </div>
    </div>
  );
}

function AuthResult({ name, value }: { name: string; value: string | null }) {
  const { t } = useT();
  const look = TONE_LOOK[authTone(value)];
  const Icon = look.icon;
  return (
    <span className="inline-flex items-center gap-1">
      <Icon className={clsx("size-3.5", look.className)} aria-hidden />
      <span className="font-semibold">{name}</span>
      <span className={look.className}>{value ?? t("assist.spam.authMissing")}</span>
    </span>
  );
}

/** Stands for the quote in the translated sentence, so the quote itself can be isolated. */
const QUOTE_SLOT = "\u{E000}";

/**
 * The translated "In the mail: “…”" with the quote in a `<bdi>`: it is mail text, and its direction
 * marks must not reorder the sentence around it (security review 0.22 webmail WF-2).
 */
function QuotedIn({ text, quote }: { text: string; quote: string }) {
  const at = text.indexOf(QUOTE_SLOT);
  if (at < 0) return <bdi>{quote}</bdi>;
  return (
    <>
      {text.slice(0, at)}
      <bdi>{quote}</bdi>
      {text.slice(at + QUOTE_SLOT.length)}
    </>
  );
}
