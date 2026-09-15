import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { Archive, Mail, MailOpen, Paperclip, Star, Trash } from "lucide-react";
import type { Account, ThreadSummary } from "@/backend/types";
import { AccountDot, Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n";
import { displayName, formatListDate } from "@/lib/format";
import type { useThreadActions } from "@/lib/queries";
import type { ListDensity } from "@/state/settings";

interface ThreadRowProps {
  thread: ThreadSummary;
  variant: "simple" | "pro";
  density: ListDensity;
  selected: boolean;
  accounts: Account[];
  showAccount: boolean;
  actions: ReturnType<typeof useThreadActions>;
  onSelect: () => void;
}

function QuickAction({
  icon: Icon,
  label,
  active,
  compact,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  compact: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      // Mouse shortcuts only: the keyboard already has e, #, u and s, and a Tab stop per button would drag.
      tabIndex={-1}
      title={label}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        "inline-flex items-center justify-center rounded-full transition-colors",
        compact ? "size-6" : "size-[26px]",
        active ? "text-pink" : "text-muted hover:bg-pink-tint hover:text-pink-ink",
      )}
    >
      <Icon className={clsx(compact ? "size-3.5" : "size-4", active && "fill-current")} strokeWidth={2} aria-hidden />
    </button>
  );
}

export function ThreadRow({
  thread,
  variant,
  density,
  selected,
  accounts,
  showAccount,
  actions,
  onSelect,
}: ThreadRowProps) {
  const { t, i18n } = useT();
  const compact = density === "compact";
  const unread = thread.unreadCount > 0;
  // Show the other people in the conversation; fall back to everyone when it's only me.
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()));
  const others = thread.participants.filter((p) => !mine.has(p.email.toLowerCase()));
  // A draft on its own has only me in it; the red label says enough then.
  const people = others.length > 0 ? others : thread.hasDraft ? [] : thread.participants;
  const lead = people[people.length - 1] ?? thread.participants[0] ?? { email: "?" };
  const names = people.map(displayName).join(", ");
  const date = formatListDate(thread.lastDate, i18n.language, t("common.yesterday"));
  const account = showAccount ? accounts.find((a) => a.id === thread.accountIds[0]) : undefined;
  const subject = thread.subject || t("reader.noSubject");

  return (
    <div
      data-thread-id={thread.id}
      className={clsx(
        "group relative flex text-left transition-colors",
        compact ? "gap-2.5 rounded-xl py-2 pr-3 pl-1.5" : "gap-3 rounded-2xl py-3 pr-3 pl-1.5",
        selected ? "bg-pink-tint" : "hover:bg-pink-tint/45",
      )}
    >
      {/* The whole card opens the thread; the quick actions sit above this button. */}
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        aria-label={[unread && t("list.unread"), thread.hasDraft && t("reader.draft"), names, subject, date]
          .filter(Boolean)
          .join(", ")}
        className="absolute inset-0 rounded-[inherit] focus-visible:shadow-focus focus-visible:outline-none"
      />

      {/* Centered on the picture: 28, 36 or 40 px tall. */}
      <span
        className={clsx(
          "pointer-events-none flex w-2 shrink-0 justify-center",
          compact ? "pt-2.5" : variant === "pro" ? "pt-3.5" : "pt-4",
        )}
      >
        {unread && <span aria-hidden className="size-2 rounded-full bg-pink" />}
      </span>

      <span className="pointer-events-none relative flex h-fit shrink-0">
        <Avatar address={lead} size={compact ? "sm" : variant === "pro" ? "list" : "md"} />
        {account && (
          <AccountDot
            color={account.color}
            className={clsx("absolute -right-0.5 -bottom-0.5 ring-2 ring-surface", compact ? "size-2.5" : "size-3")}
          />
        )}
      </span>

      <span className={clsx("pointer-events-none flex min-w-0 flex-1 flex-col", compact ? "gap-0" : "gap-0.5")}>
        <span className="flex items-baseline gap-2">
          <span
            className={clsx(
              "min-w-0 flex-1 truncate",
              compact ? "text-[13.5px]" : "text-[14px]",
              unread ? "font-bold text-ink" : "font-semibold text-ink/85",
            )}
          >
            {thread.hasDraft && (
              <span className="mr-1.5 font-bold text-danger">
                {t("reader.draft")}
                {names && ","}
              </span>
            )}
            {names}
            {thread.messageCount > 1 && (
              <span className="ml-1.5 text-[12px] font-semibold text-muted">{thread.messageCount}</span>
            )}
          </span>
          <span className="flex shrink-0 items-center gap-1.5 self-center transition-opacity group-hover:opacity-0">
            {thread.hasAttachments && <Paperclip className="size-3.5 text-muted" aria-hidden />}
            {thread.flagged && <Star className="size-3.5 fill-pink text-pink" aria-hidden />}
            <span
              className={clsx(
                "text-[12px] tabular-nums",
                unread ? "font-bold text-pink-ink" : "font-medium text-muted",
              )}
            >
              {date}
            </span>
          </span>
        </span>

        {compact ? (
          <span className="truncate text-[13px]">
            <span className={clsx(unread ? "font-semibold text-ink" : "text-ink/80")}>{subject}</span>
            <span className="text-muted"> · {thread.snippet}</span>
          </span>
        ) : (
          <>
            <span className={clsx("truncate text-[13.5px]", unread ? "font-semibold text-ink" : "text-ink/80")}>
              {subject}
            </span>
            <span
              className={clsx(
                "text-[13px] leading-snug text-muted",
                variant === "simple" ? "line-clamp-2" : "truncate",
              )}
            >
              {thread.snippet}
            </span>
          </>
        )}
      </span>

      <span
        className={clsx(
          "absolute right-2 hidden -translate-y-1/2 items-center gap-0.5 rounded-full border border-hairline bg-surface p-0.5 shadow-[0_2px_8px_rgb(28_20_32/0.08)] group-hover:flex",
          // Centered on the first line, where the date was.
          compact ? "top-[18px]" : "top-[22px]",
        )}
      >
        <QuickAction
          icon={Archive}
          label={t("reader.archive")}
          compact={compact}
          onClick={() => void actions.archive(thread)}
        />
        <QuickAction
          icon={Trash}
          label={t("reader.trash")}
          compact={compact}
          onClick={() => void actions.trash(thread)}
        />
        <QuickAction
          icon={unread ? MailOpen : Mail}
          label={unread ? t("list.markRead") : t("reader.markUnread")}
          compact={compact}
          onClick={() => void actions.toggleRead(thread)}
        />
        <QuickAction
          icon={Star}
          label={thread.flagged ? t("reader.unflag") : t("reader.flag")}
          active={thread.flagged}
          compact={compact}
          onClick={() => void actions.toggleFlag(thread)}
        />
      </span>
    </div>
  );
}
