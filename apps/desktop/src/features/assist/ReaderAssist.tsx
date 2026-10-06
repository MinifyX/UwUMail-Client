import { Icon, IconButton, type IconProps, ICONS, Menu, type MenuEntry, type MenuItem } from "@uwusuite/design";
import type { Message } from "@/backend/types";
import { useT } from "@/i18n";
import { useCalendarsAvailable } from "../calendar/useCalendarData";
import { useEventSearch } from "../dates/search";
import { hasOwnPictures } from "../dates/useMailEvents";
import { EstimateLabel, type EstimateRequest } from "./estimate";
import { LabelSuggestCard } from "./LabelSuggestCard";
import { mailKey, threadKey, useAssistReader } from "./readerState";
import { SpamCheckCard } from "./SpamCheckCard";
import { SummaryCard } from "./SummaryCard";
import { useAssistFeatures } from "./useAssist";

/** What the assistant can do in the reader for this mail: only the own account's mail has it. */
export function useReaderAssist(own: boolean) {
  const { data: features } = useAssistFeatures();
  const { data: calendars = false } = useCalendarsAvailable();
  return {
    summarize: own && features?.summarize === true,
    spamCheck: own && features?.spamCheck === true,
    // Found appointments go into a calendar, so only where there is one.
    events: own && calendars && features?.extractEvents === true,
    // "Label again" works wherever the model may label this mailbox's mail.
    labels: own && features?.autoLabels === true,
  };
}

function ItemLabel({
  icon: Glyph,
  text,
  estimate,
}: {
  icon: IconProps["icon"];
  text: string;
  /** The call behind the item, for "≈ 1,200 tokens" while it is hovered or held. */
  estimate?: EstimateRequest;
}) {
  const label = (
    <span className="flex items-center gap-2.5">
      <Icon icon={Glyph} className="shrink-0 text-muted" />
      {text}
    </span>
  );
  return estimate ? <EstimateLabel request={estimate}>{label}</EstimateLabel> : label;
}

/** The calls of the reader's items, as the estimate needs them. */
function summaryEstimate(message: Message, kind: "mail" | "thread", language: string): EstimateRequest {
  const args = kind === "mail" ? { emailId: message.id, language } : { threadId: message.threadId, language };
  return { accountId: message.accountId, method: "Assist/summarize", args };
}

function spamEstimate(message: Message, language: string): EstimateRequest {
  return { accountId: message.accountId, method: "Assist/spamCheck", args: { emailId: message.id, language } };
}

function eventsEstimate(message: Message): EstimateRequest {
  // Remote pictures only go along once they may load, which the reader decides; the own ones always.
  const includeImages = hasOwnPictures(message) && !message.hasRemoteContent;
  return { accountId: message.accountId, method: "Assist/extractEvents", args: { emailId: message.id, includeImages } };
}

function labelsEstimate(message: Message, language: string): EstimateRequest {
  return {
    accountId: message.accountId,
    method: "AssistLabel/suggest",
    args: { emailId: message.id, language, suggestNew: true },
  };
}

/** "Find appointment": the assistant reads the mail for dates now, whatever the automatic setting says. */
function findEvents(message: Message) {
  useEventSearch.getState().ask(message.id);
}

/** "Summarize" and "Check for spam" for one mail, for its "more" menu. */
export function useMessageAssistItems(message: Message, own: boolean, fromMe: boolean): MenuEntry[] {
  const { t, i18n } = useT();
  const can = useReaderAssist(own);
  const showSummary = useAssistReader((s) => s.showSummary);
  const showSpamCheck = useAssistReader((s) => s.showSpamCheck);
  const showLabelCheck = useAssistReader((s) => s.showLabelCheck);
  if (message.flags.draft) return [];
  const items: MenuItem[] = [
    ...(can.summarize
      ? [
          {
            label: (
              <ItemLabel
                icon={ICONS.summary}
                text={t("assist.summary.summarizeMail")}
                estimate={summaryEstimate(message, "mail", i18n.language)}
              />
            ),
            onSelect: () => showSummary(mailKey(message.id)),
          },
        ]
      : []),
    ...(can.events
      ? [
          {
            label: (
              <ItemLabel icon={ICONS.findEvent} text={t("dates.findAppointment")} estimate={eventsEstimate(message)} />
            ),
            onSelect: () => findEvents(message),
          },
        ]
      : []),
    ...(can.spamCheck && !fromMe
      ? [
          {
            label: (
              <ItemLabel
                icon={ICONS.spamCheck}
                text={t("assist.spam.check")}
                estimate={spamEstimate(message, i18n.language)}
              />
            ),
            onSelect: () => showSpamCheck(message.id),
          },
        ]
      : []),
    ...(can.labels
      ? [
          {
            label: (
              <ItemLabel
                icon={ICONS.labels}
                text={t("assist.labelAgain.menu")}
                estimate={labelsEstimate(message, i18n.language)}
              />
            ),
            onSelect: () => showLabelCheck(message.id),
          },
        ]
      : []),
  ];
  // Under their own heading in the mail's "more" menu.
  return items.length > 0 ? [{ heading: t("assist.menuGroup") }, ...items] : [];
}

interface ThreadAssistButtonProps {
  threadId: string;
  messages: Message[];
  own: boolean;
  /** The addresses of the account, to leave its own mail out of spam checks. */
  mine: Set<string>;
  align?: "start" | "end";
}

/** ✨ in the reader's toolbar: summarize the conversation, or check its newest mail for spam. */
export function ThreadAssistButton({ threadId, messages, own, mine, align }: ThreadAssistButtonProps) {
  const { t, i18n } = useT();
  const language = i18n.language;
  const can = useReaderAssist(own);
  const showSummary = useAssistReader((s) => s.showSummary);
  const showSpamCheck = useAssistReader((s) => s.showSpamCheck);
  const showLabelCheck = useAssistReader((s) => s.showLabelCheck);
  const sent = messages.filter((message) => !message.flags.draft);
  const received = sent.filter((message) => !mine.has(message.from.email.toLowerCase()));
  const newest = received[received.length - 1];
  // Appointments and labels go by the newest mail that came, or else the newest one at all.
  const forEvents = newest ?? sent[sent.length - 1];
  const items: MenuItem[] = [
    ...(can.summarize
      ? messages.length > 1
        ? [
            {
              label: (
                <ItemLabel
                  icon={ICONS.summary}
                  text={t("assist.summary.summarizeThread")}
                  estimate={summaryEstimate({ ...messages.at(-1)!, threadId }, "thread", language)}
                />
              ),
              onSelect: () => showSummary(threadKey(threadId)),
            },
            ...(newest
              ? [
                  {
                    label: (
                      <ItemLabel
                        icon={ICONS.summary}
                        text={t("assist.summary.summarizeLatest")}
                        estimate={summaryEstimate(newest, "mail", language)}
                      />
                    ),
                    onSelect: () => showSummary(mailKey(newest.id)),
                  },
                ]
              : []),
          ]
        : [
            {
              label: (
                <ItemLabel
                  icon={ICONS.summary}
                  text={t("assist.summary.summarizeMail")}
                  estimate={summaryEstimate(messages[0]!, "mail", language)}
                />
              ),
              onSelect: () => showSummary(mailKey(messages[0]!.id)),
            },
          ]
      : []),
    ...(can.events && forEvents
      ? [
          {
            label: (
              <ItemLabel
                icon={ICONS.findEvent}
                text={t("dates.findAppointment")}
                estimate={eventsEstimate(forEvents)}
              />
            ),
            onSelect: () => findEvents(forEvents),
          },
        ]
      : []),
    ...(can.spamCheck && newest
      ? [
          {
            label: (
              <ItemLabel
                icon={ICONS.spamCheck}
                text={t("assist.spam.check")}
                estimate={spamEstimate(newest, language)}
              />
            ),
            onSelect: () => showSpamCheck(newest.id),
          },
        ]
      : []),
    ...(can.labels && forEvents
      ? [
          {
            label: (
              <ItemLabel
                icon={ICONS.labels}
                text={t(messages.length > 1 ? "assist.labelAgain.menuLatest" : "assist.labelAgain.menu")}
                estimate={labelsEstimate(forEvents, language)}
              />
            ),
            onSelect: () => showLabelCheck(forEvents.id),
          },
        ]
      : []),
  ];
  if (items.length === 0) return null;
  return (
    <Menu
      align={align}
      items={items}
      trigger={(menu) => (
        <IconButton
          icon={ICONS.ai}
          label={t("assist.reader.button")}
          onClick={menu.toggle}
          aria-haspopup={menu["aria-haspopup"]}
          aria-expanded={menu["aria-expanded"]}
          aria-controls={menu["aria-controls"]}
        />
      )}
    />
  );
}

/** The conversation's summary, under its subject, while it is asked for. */
export function ThreadSummary({ threadId, count }: { threadId: string; count: number }) {
  const shown = useAssistReader((s) => s.summaries[threadKey(threadId)] === true);
  if (!shown) return null;
  return <SummaryCard kind="thread" id={threadId} count={count} />;
}

/** One mail's summary, spam check and label suggestions, above its text, while they are asked for. */
export function MessageAssistCards({ message, inJunk }: { message: Message; inJunk: boolean }) {
  const summary = useAssistReader((s) => s.summaries[mailKey(message.id)] === true);
  const spamCheck = useAssistReader((s) => s.spamChecks[message.id] === true);
  const labels = useAssistReader((s) => s.labelChecks[message.id] === true);
  if (!summary && !spamCheck && !labels) return null;
  return (
    <>
      {summary && <SummaryCard kind="mail" id={message.id} />}
      {spamCheck && <SpamCheckCard message={message} inJunk={inJunk} />}
      {labels && <LabelSuggestCard message={message} />}
    </>
  );
}
