import clsx from "clsx";
import { ChevronDown, ImageIcon, ImageOff, Moon, PenLine, Sun } from "lucide-react";
import { useState } from "react";
import type { Account, Message } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { useT } from "@/i18n";
import { displayName, formatFullDate, formatListDate } from "@/lib/format";
import { useCompanyDomain } from "@/lib/queries";
import { useResolvedTheme } from "@/lib/theme";
import { domainEntry, isDomainEntry, matchingEntries } from "@/lib/trustedSenders";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { AttachmentTiles } from "../attachments/AttachmentTiles";
import { openDraftMessage } from "../compose/openDraft";
import { useInlineImages } from "./useInlineImages";
import { MessageBody, resolveAppearance, type Appearance } from "./MessageBody";

interface AppearanceToggleProps {
  message: Message;
  appearance: Appearance;
  autoDark: boolean | undefined;
}

/** "☀ Hell" / "☾ Dunkel" in the message header. Only rendered in the dark app theme. */
function AppearanceToggle({ message, appearance, autoDark }: AppearanceToggleProps) {
  const { t } = useT();
  const rememberAppearance = useSettings((s) => s.rememberAppearance);
  const isDark =
    appearance.kind === "dark" || appearance.kind === "darken" || (appearance.kind === "auto" && autoDark === true);
  // Wait for the automatic decision so the label doesn't flip.
  if (appearance.kind === "auto" && autoDark === undefined) return null;

  const why =
    appearance.kind === "auto"
      ? autoDark
        ? t("reader.appearanceAutoDark")
        : t("reader.appearanceAutoLight")
      : appearance.kind === "dark" && appearance.why === "native"
        ? t("reader.appearanceNative")
        : undefined;
  const action = isDark ? t("reader.appearanceShowLight") : t("reader.appearanceShowDark");
  const Icon = isDark ? Sun : Moon;

  return (
    <button
      type="button"
      title={why ? `${why} ${action}` : action}
      aria-label={action}
      onClick={() => {
        rememberAppearance(message.from.email, isDark ? "light" : "dark");
        toast(t("reader.appearanceRemembered", { email: message.from.email }), "info");
      }}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] font-semibold text-muted transition-colors hover:border-pink hover:bg-pink-tint hover:text-pink-ink"
    >
      <Icon className="size-3.5" aria-hidden />
      {isDark ? t("reader.appearanceLight") : t("reader.appearanceDark")}
    </button>
  );
}

/** "Load images" for this mail, or always for the address or its whole company. */
function RemoteImagesBanner({ email, onLoad }: { email: string; onLoad: () => void }) {
  const { t } = useT();
  const trustSender = useSettings((s) => s.trustSender);
  const domain = useCompanyDomain(email);
  const trust = (entry: string) => {
    trustSender(entry);
    toast(
      isDomainEntry(entry)
        ? t("reader.remoteTrustedDomain", { domain: entry.slice(1) })
        : t("reader.remoteTrustedAddress", { email: entry }),
      "success",
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-pink-tint/70 px-4 py-2.5 text-[13px] text-pink-ink">
      <ImageOff className="size-4 shrink-0" aria-hidden />
      <span className="min-w-[min(100%,14rem)] flex-1">{t("reader.remoteBlocked")}</span>
      <span className="ml-auto flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={onLoad}>
          {t("reader.remoteLoad")}
        </Button>
        {domain ? (
          <Menu
            align="end"
            items={[
              { label: t("reader.remoteTrustAddress", { email }), onSelect: () => trust(email) },
              { label: t("reader.remoteTrustDomain", { domain }), onSelect: () => trust(domainEntry(domain)) },
            ]}
            trigger={({ open, toggle, ...menu }) => (
              <Button size="sm" variant="ghost" onClick={toggle} {...menu}>
                {t("reader.remoteTrust")}
                <ChevronDown
                  className={clsx("size-3.5 transition-transform", open && "rotate-180")}
                  strokeWidth={2.4}
                  aria-hidden
                />
              </Button>
            )}
          />
        ) : (
          <Button size="sm" variant="ghost" onClick={() => trust(email)}>
            {t("reader.remoteTrustOnly", { email })}
          </Button>
        )}
      </span>
    </div>
  );
}

/** Quiet note in a mail whose images load because the sender is on the list. */
function TrustedImagesNote({ entries, onUntrust }: { entries: string[]; onUntrust: () => void }) {
  const { t } = useT();
  const untrustSenders = useSettings((s) => s.untrustSenders);
  // A whole company says more than one of its addresses.
  const entry = entries.find(isDomainEntry) ?? entries[0]!;
  const who = isDomainEntry(entry) ? { domain: entry.slice(1) } : { email: entry };
  const key = isDomainEntry(entry) ? "Domain" : "Address";

  return (
    <p className="-mt-1 flex flex-wrap items-center gap-x-1.5 px-1 text-[12px] text-muted">
      <ImageIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{t(`reader.remoteLoading${key}`, who)}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        onClick={() => {
          untrustSenders(entries);
          onUntrust();
          toast(t(`reader.remoteUntrusted${key}`, who), "info");
        }}
        className="rounded font-semibold text-pink-ink hover:underline focus-visible:shadow-focus focus-visible:outline-none"
      >
        {t("reader.remoteUntrust")}
      </button>
    </p>
  );
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
  const mailAppearance = useSettings((s) => s.mailAppearance);
  const senderChoice = useSettings((s) => s.senderAppearance[message.from.email.toLowerCase()]);
  const [loadRemote, setLoadRemote] = useState(false);
  const inlineImages = useInlineImages(message);
  const [autoDecision, setAutoDecision] = useState<{ key: string; dark: boolean } | null>(null);

  const myAddresses = new Set(accounts.map((a) => a.email.toLowerCase()));
  const recipientNames = message.to
    .map((address) => (myAddresses.has(address.email.toLowerCase()) ? t("reader.me") : displayName(address)))
    .join(", ");
  const trustedBy = matchingEntries(message.from.email, trustedSenders);
  const allowRemote = loadRemote || remoteSetting === "always" || trustedBy.length > 0;

  // A remembered choice for this sender wins; plain text otherwise follows the app.
  const preference = senderChoice ?? (message.bodyHtml !== null ? mailAppearance : "auto");
  const appearance = resolveAppearance(message, theme === "dark", preference);
  const decisionKey = `${message.id}|${allowRemote}`;
  const autoDark = autoDecision?.key === decisionKey ? autoDecision.dark : undefined;

  if (collapsed) {
    return (
      <button
        type="button"
        // A draft is continued in the composer rather than read.
        onClick={message.flags.draft ? () => void openDraftMessage(message.id) : onExpand}
        className="flex w-full items-center gap-3 rounded-2xl border border-hairline bg-surface px-4 py-3 text-left hover:bg-elevated"
      >
        <Avatar address={message.from} size="sm" />
        <span
          className={clsx("w-36 shrink-0 truncate text-[13.5px]", message.flags.seen ? "font-semibold" : "font-bold")}
        >
          {message.flags.draft ? <span className="text-danger">{t("reader.draft")}</span> : displayName(message.from)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">{message.snippet}</span>
        {message.flags.draft && <PenLine className="size-4 shrink-0 text-muted" aria-hidden />}
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
        <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1">
          <div className="min-w-[min(100%,12rem)] flex-1">
            <p className="flex flex-wrap items-baseline gap-x-2">
              <span className="min-w-0 text-[15px] font-bold break-words">{displayName(message.from)}</span>
              <span className="selectable min-w-0 truncate text-[12.5px] text-muted">{message.from.email}</span>
            </p>
            <p className="truncate text-[12.5px] text-muted">{t("reader.to", { names: recipientNames })}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {message.flags.draft && (
              <>
                <span className="rounded-full bg-danger-tint px-2 py-0.5 text-[12px] font-bold text-danger">
                  {t("reader.draft")}
                </span>
                <Button size="sm" icon={PenLine} onClick={() => void openDraftMessage(message.id)}>
                  {t("reader.continueDraft")}
                </Button>
              </>
            )}
            {theme === "dark" && <AppearanceToggle message={message} appearance={appearance} autoDark={autoDark} />}
            <time dateTime={message.date} className="text-[12.5px] text-muted">
              {formatFullDate(message.date, i18n.language)}
            </time>
          </div>
        </div>
      </header>

      {message.hasRemoteContent && !allowRemote && (
        <RemoteImagesBanner email={message.from.email} onLoad={() => setLoadRemote(true)} />
      )}
      {message.hasRemoteContent && remoteSetting !== "always" && trustedBy.length > 0 && (
        <TrustedImagesNote entries={trustedBy} onUntrust={() => setLoadRemote(false)} />
      )}

      <div className="selectable">
        <MessageBody
          message={message}
          allowRemote={allowRemote}
          appearance={appearance}
          onAutoDecision={(dark) => setAutoDecision({ key: decisionKey, dark })}
          inlineImages={inlineImages.urls}
        />
      </div>

      <AttachmentTiles
        attachments={message.attachments.filter((attachment) => !inlineImages.shown.has(attachment.id))}
        sender={message.from}
      />
    </article>
  );
}
