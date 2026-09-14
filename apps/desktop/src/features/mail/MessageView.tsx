import clsx from "clsx";
import { File, FileImage, FileText, ImageOff, Paperclip } from "lucide-react";
import type { Account, Attachment, Message } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { displayName, formatFullDate, formatListDate, formatSize } from "@/lib/format";
import { useResolvedTheme } from "@/lib/theme";
import { useSettings } from "@/state/settings";
import { MessageBody } from "./MessageBody";
import { useState } from "react";

function attachmentIcon(attachment: Attachment) {
  if (attachment.mimeType.startsWith("image/")) return FileImage;
  if (attachment.mimeType.startsWith("text/") || attachment.mimeType === "application/pdf") return FileText;
  return File;
}

interface MessageViewProps {
  message: Message;
  accounts: Account[];
  collapsed: boolean;
  onExpand: () => void;
}

export function MessageView({ message, accounts, collapsed, onExpand }: MessageViewProps) {
  const { t, i18n } = useT();
  const theme = useResolvedTheme();
  const remoteSetting = useSettings((s) => s.remoteImages);
  const trustedSenders = useSettings((s) => s.trustedSenders);
  const trustSender = useSettings((s) => s.trustSender);
  const [loadRemote, setLoadRemote] = useState(false);

  const myAddresses = new Set(accounts.map((a) => a.email.toLowerCase()));
  const recipientNames = message.to
    .map((address) => (myAddresses.has(address.email.toLowerCase()) ? t("reader.me") : displayName(address)))
    .join(", ");
  const allowRemote =
    loadRemote || remoteSetting === "always" || trustedSenders.includes(message.from.email.toLowerCase());

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3 text-left hover:bg-elevated"
      >
        <Avatar address={message.from} size="sm" />
        <span
          className={clsx("w-36 shrink-0 truncate text-[13.5px]", message.flags.seen ? "font-semibold" : "font-bold")}
        >
          {displayName(message.from)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{message.snippet}</span>
        <span className="shrink-0 text-[12px] text-muted">
          {formatListDate(message.date, i18n.language, t("common.yesterday"))}
        </span>
      </button>
    );
  }

  return (
    <article className="flex animate-fade flex-col gap-4 rounded-[20px] border border-hairline bg-surface p-5">
      <header className="flex items-start gap-3">
        <Avatar address={message.from} />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[15px] font-bold">{displayName(message.from)}</span>
            <span className="selectable truncate text-[12.5px] text-muted">{message.from.email}</span>
          </p>
          <p className="truncate text-[12.5px] text-muted">{t("reader.to", { names: recipientNames })}</p>
        </div>
        <time dateTime={message.date} className="shrink-0 text-[12.5px] text-muted">
          {formatFullDate(message.date, i18n.language)}
        </time>
      </header>

      {message.hasRemoteContent && !allowRemote && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-pink-tint/70 px-4 py-2.5 text-[13px] text-pink-ink">
          <ImageOff className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{t("reader.remoteBlocked")}</span>
          <Button size="sm" variant="secondary" onClick={() => setLoadRemote(true)}>
            {t("reader.remoteLoad")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => trustSender(message.from.email)}>
            {t("reader.remoteTrust", { email: message.from.email })}
          </Button>
        </div>
      )}

      <div className="selectable">
        <MessageBody message={message} allowRemote={allowRemote} dark={theme === "dark"} />
      </div>

      {message.attachments.length > 0 && (
        <footer className="flex flex-col gap-2 border-t border-hairline pt-4">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted">
            <Paperclip className="size-3.5" aria-hidden />
            {t("reader.attachments", { count: message.attachments.length })}
          </p>
          <ul className="flex flex-wrap gap-2">
            {message.attachments.map((attachment) => {
              const Icon = attachmentIcon(attachment);
              return (
                <li key={attachment.id}>
                  <button
                    type="button"
                    className="flex max-w-[260px] items-center gap-2.5 rounded-xl border border-line bg-surface py-2 pr-3 pl-2.5 text-left hover:border-pink hover:bg-pink-tint/40"
                  >
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-pink-tint text-pink-ink">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{attachment.filename}</span>
                      <span className="block text-[11.5px] text-muted">
                        {formatSize(attachment.size, i18n.language)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </footer>
      )}
    </article>
  );
}
