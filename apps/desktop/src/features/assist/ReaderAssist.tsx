import { FileText, ShieldQuestion, Sparkles, type LucideIcon } from "lucide-react";
import type { Message } from "@/backend/types";
import { IconButton } from "@/components/ui/Button";
import type { MenuItem } from "@/components/ui/Menu";
import { Menu } from "@/components/ui/Menu";
import { useT } from "@/i18n";
import { mailKey, threadKey, useAssistReader } from "./readerState";
import { SpamCheckCard } from "./SpamCheckCard";
import { SummaryCard } from "./SummaryCard";
import { useAssistFeatures } from "./useAssist";

/** What the assistant can do in the reader for this mail: only the own account's mail has it. */
export function useReaderAssist(own: boolean) {
  const { data: features } = useAssistFeatures();
  return {
    summarize: own && features?.summarize === true,
    spamCheck: own && features?.spamCheck === true,
  };
}

function ItemLabel({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <Icon className="size-4 shrink-0 text-muted" aria-hidden />
      {text}
    </span>
  );
}

/** "Summarize" and "Check for spam" for one mail, for its "more" menu. */
export function useMessageAssistItems(message: Message, own: boolean, fromMe: boolean): MenuItem[] {
  const { t } = useT();
  const can = useReaderAssist(own);
  const showSummary = useAssistReader((s) => s.showSummary);
  const showSpamCheck = useAssistReader((s) => s.showSpamCheck);
  if (message.flags.draft) return [];
  return [
    ...(can.summarize
      ? [
          {
            label: <ItemLabel icon={FileText} text={t("assist.summary.summarizeMail")} />,
            onSelect: () => showSummary(mailKey(message.id)),
          },
        ]
      : []),
    ...(can.spamCheck && !fromMe
      ? [
          {
            label: <ItemLabel icon={ShieldQuestion} text={t("assist.spam.check")} />,
            onSelect: () => showSpamCheck(message.id),
          },
        ]
      : []),
  ];
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
  const { t } = useT();
  const can = useReaderAssist(own);
  const showSummary = useAssistReader((s) => s.showSummary);
  const showSpamCheck = useAssistReader((s) => s.showSpamCheck);
  const received = messages.filter((message) => !message.flags.draft && !mine.has(message.from.email.toLowerCase()));
  const newest = received[received.length - 1];
  const items: MenuItem[] = [
    ...(can.summarize
      ? messages.length > 1
        ? [
            {
              label: <ItemLabel icon={Sparkles} text={t("assist.summary.summarizeThread")} />,
              onSelect: () => showSummary(threadKey(threadId)),
            },
            ...(newest
              ? [
                  {
                    label: <ItemLabel icon={FileText} text={t("assist.summary.summarizeLatest")} />,
                    onSelect: () => showSummary(mailKey(newest.id)),
                  },
                ]
              : []),
          ]
        : [
            {
              label: <ItemLabel icon={Sparkles} text={t("assist.summary.summarizeMail")} />,
              onSelect: () => showSummary(mailKey(messages[0]!.id)),
            },
          ]
      : []),
    ...(can.spamCheck && newest
      ? [
          {
            label: <ItemLabel icon={ShieldQuestion} text={t("assist.spam.check")} />,
            onSelect: () => showSpamCheck(newest.id),
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
          icon={Sparkles}
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

/** One mail's summary and spam check, above its text, while they are asked for. */
export function MessageAssistCards({ message, inJunk }: { message: Message; inJunk: boolean }) {
  const summary = useAssistReader((s) => s.summaries[mailKey(message.id)] === true);
  const spamCheck = useAssistReader((s) => s.spamChecks[message.id] === true);
  if (!summary && !spamCheck) return null;
  return (
    <>
      {summary && <SummaryCard kind="mail" id={message.id} />}
      {spamCheck && <SpamCheckCard message={message} inJunk={inJunk} />}
    </>
  );
}
