import clsx from "clsx";
import { Paperclip, Star } from "lucide-react";
import type { Account, ThreadSummary } from "@/backend/types";
import { AccountDot, Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n";
import { displayName, formatListDate } from "@/lib/format";

interface ThreadRowProps {
  thread: ThreadSummary;
  variant: "simple" | "pro";
  selected: boolean;
  accounts: Account[];
  showAccount: boolean;
  onSelect: () => void;
}

export function ThreadRow({ thread, variant, selected, accounts, showAccount, onSelect }: ThreadRowProps) {
  const { t, i18n } = useT();
  const unread = thread.unreadCount > 0;
  // Show the other people in the conversation; fall back to everyone when it's only me.
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));
  const others = thread.participants.filter((p) => !mine.has(p.email.toLowerCase()));
  const people = others.length > 0 ? others : thread.participants;
  const lead = people[people.length - 1] ?? { email: "?" };
  const names = people.map(displayName).join(", ");
  const date = formatListDate(thread.lastDate, i18n.language, t("common.yesterday"));
  const account = showAccount ? accounts.find((a) => a.id === thread.accountIds[0]) : undefined;
  const subject = thread.subject || t("reader.noSubject");

  if (variant === "pro") {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        data-thread-id={thread.id}
        className={clsx(
          "relative flex w-full flex-col gap-0.5 border-b border-hairline py-2 pr-4 pl-5 text-left text-[13px] transition-colors",
          selected ? "bg-pink-tint" : "hover:bg-elevated",
        )}
      >
        {unread && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-pink" />}
        <span className="flex items-center gap-2">
          {account && <AccountDot color={account.color} />}
          <span className={clsx("min-w-0 flex-1 truncate", unread ? "font-bold text-ink" : "font-medium text-ink/80")}>
            {names}
            {thread.messageCount > 1 && <span className="ml-1 font-medium text-muted">{thread.messageCount}</span>}
          </span>
          {thread.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-muted" aria-hidden />}
          {thread.flagged && <Star className="size-3.5 shrink-0 fill-pink text-pink" aria-hidden />}
          <span
            className={clsx("shrink-0 text-[12px] tabular-nums", unread ? "font-semibold text-pink-ink" : "text-muted")}
          >
            {date}
          </span>
        </span>
        <span className="truncate">
          <span className={clsx(unread ? "font-semibold text-ink" : "text-ink/85")}>{subject}</span>
          <span className="text-muted"> · {thread.snippet}</span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      data-thread-id={thread.id}
      className={clsx(
        "flex w-full gap-3 rounded-2xl px-3 py-3 text-left transition-colors",
        selected ? "bg-pink-tint" : "hover:bg-elevated",
      )}
    >
      <span className="relative flex h-fit shrink-0">
        <Avatar address={lead} />
        {account && (
          <AccountDot color={account.color} className="absolute -right-0.5 -bottom-0.5 size-3 ring-2 ring-surface" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span
            className={clsx("min-w-0 flex-1 truncate text-[14px]", unread ? "font-bold" : "font-semibold text-ink/85")}
          >
            {names}
            {thread.messageCount > 1 && (
              <span className="ml-1.5 text-[12px] font-semibold text-muted">{thread.messageCount}</span>
            )}
          </span>
          <span
            className={clsx("shrink-0 text-[12px] tabular-nums", unread ? "font-bold text-pink-ink" : "text-muted")}
          >
            {date}
          </span>
        </span>
        <span className="flex items-center gap-2">
          <span
            className={clsx("min-w-0 flex-1 truncate text-[13.5px]", unread ? "font-semibold text-ink" : "text-ink/80")}
          >
            {subject}
          </span>
          {thread.hasAttachments && <Paperclip className="size-3.5 shrink-0 text-muted" aria-hidden />}
          {thread.flagged && <Star className="size-3.5 shrink-0 fill-pink text-pink" aria-hidden />}
          {unread && (
            <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-pink px-1.5 text-[11px] font-bold text-white">
              {thread.unreadCount}
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-[13px] leading-snug text-muted">{thread.snippet}</span>
      </span>
    </button>
  );
}
