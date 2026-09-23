import clsx from "clsx";
import {
  Ban,
  ChevronDown,
  Copy,
  Download,
  ImageIcon,
  ImageOff,
  Moon,
  MoreHorizontal,
  PenLine,
  Printer,
  Sun,
} from "lucide-react";
import { Fragment, useId, useState } from "react";
import type { Account, Message } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { Button, IconButton } from "@/components/ui/Button";
import { Menu } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { translate, useT } from "@/i18n";
import { addressRows, fullAddress, type AddressRole } from "@/lib/addresses";
import { visibleText } from "@/lib/links";
import { displayName, formatFullDate, formatListDate, formatLongDate } from "@/lib/format";
import { useQueryClient } from "@tanstack/react-query";
import { useCompanyDomain, useFolders } from "@/lib/queries";
import { useUi } from "@/state/ui";
import { useResolvedTheme } from "@/lib/theme";
import { domainEntry, isDomainEntry, matchingEntries } from "@/lib/trustedSenders";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { AttachmentTiles } from "../attachments/AttachmentTiles";
import { openDraftMessage } from "../compose/openDraft";
import { useInlineImages } from "./useInlineImages";
import { nativeMobile } from "@/backend/mobile";
import { backend } from "@/backend/backend";
import { blockSender } from "./selection";
import { UnsubscribeButton } from "./Unsubscribe";
import { buildPrintDocument, MessageBody, resolveAppearance, type Appearance } from "./MessageBody";

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

const loadMailImage = (url: string) => backend().fetchMailImage(url);

export function MessageView({ message, accounts, collapsed, onExpand }: MessageViewProps) {
  const { t, i18n } = useT();
  const theme = useResolvedTheme();
  const remoteSetting = useSettings((s) => s.remoteImages);
  const trustedSenders = useSettings((s) => s.trustedSenders);
  const mailAppearance = useSettings((s) => s.mailAppearance);
  const senderChoice = useSettings((s) => s.senderAppearance[message.from.email.toLowerCase()]);
  const darkImages = useSettings((s) => s.darkImages);
  const [loadRemote, setLoadRemote] = useState(false);
  const inlineImages = useInlineImages(message);
  const [autoDecision, setAutoDecision] = useState<{ key: string; dark: boolean } | null>(null);

  const myAddresses = new Set(accounts.map((a) => a.email.toLowerCase()));
  const showDetails = useSettings((s) => s.showAddressDetails);
  const toggleDetails = () => useSettings.getState().update({ showAddressDetails: !showDetails });
  const detailsId = useId();
  const { data: folders = [] } = useFolders();
  // Mail the server filed in Junk was found suspicious; do not auto-load its remote content on the
  // strength of the From address alone, which an attacker controls (webmail security audit W-4). An explicit
  // "load images" click still works.
  const inJunk = folders.find((folder) => folder.id === message.folderId)?.role === "junk";
  const trustedBy = matchingEntries(message.from.email, trustedSenders);
  const allowRemote = loadRemote || (!inJunk && (remoteSetting === "always" || trustedBy.length > 0));

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
              <Tooltip
                content={fullAddress(message.from)}
                onActivate={toggleDetails}
                className="min-w-0 text-[15px] font-bold break-words"
              >
                {displayName(message.from)}
              </Tooltip>
              <span className="selectable min-w-0 truncate text-[12.5px] text-muted">
                {visibleText(message.from.email)}
              </span>
            </p>
            <p className="flex min-w-0 items-center gap-0.5 text-[12.5px] text-muted">
              <span className="min-w-0 truncate">
                <RecipientNames recipients={message.to} mine={myAddresses} onActivate={toggleDetails} />
              </span>
              <button
                type="button"
                aria-expanded={showDetails}
                aria-controls={detailsId}
                aria-label={showDetails ? t("reader.hideAddresses") : t("reader.showAddresses")}
                title={showDetails ? t("reader.hideAddresses") : t("reader.showAddresses")}
                onClick={toggleDetails}
                className="grid size-6 shrink-0 place-items-center rounded-full text-muted hover:bg-pink-tint hover:text-pink-ink focus-visible:shadow-focus focus-visible:outline-none"
              >
                <ChevronDown
                  className={clsx("size-3.5 transition-transform", showDetails && "rotate-180")}
                  strokeWidth={2.4}
                  aria-hidden
                />
              </button>
            </p>
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
            {!message.flags.draft && !myAddresses.has(message.from.email.toLowerCase()) && (
              <UnsubscribeButton message={message} />
            )}
            {theme === "dark" && <AppearanceToggle message={message} appearance={appearance} autoDark={autoDark} />}
            {!message.flags.draft && (
              <MessageMenu
                message={message}
                accounts={accounts}
                onPrint={() => printMessage(message, allowRemote, inlineImages.urls)}
              />
            )}
            <time dateTime={message.date} className="text-[12.5px] text-muted">
              {formatFullDate(message.date, i18n.language)}
            </time>
          </div>
        </div>
      </header>

      {showDetails && <AddressDetails id={detailsId} message={message} />}

      {message.hasRemoteContent && !allowRemote && (
        <RemoteImagesBanner email={message.from.email} onLoad={() => setLoadRemote(true)} />
      )}
      {message.hasRemoteContent && remoteSetting !== "always" && trustedBy.length > 0 && !inJunk && (
        <TrustedImagesNote entries={trustedBy} onUntrust={() => setLoadRemote(false)} />
      )}

      <div className="selectable">
        <MessageBody
          message={message}
          allowRemote={allowRemote}
          appearance={appearance}
          onAutoDecision={(dark) => setAutoDecision({ key: decisionKey, dark })}
          inlineImages={inlineImages.urls}
          darkImages={darkImages}
          loadRemoteImage={loadMailImage}
        />
      </div>

      <AttachmentTiles
        attachments={message.attachments.filter((attachment) => !inlineImages.shown.has(attachment.id))}
        sender={message.from}
      />
    </article>
  );
}

/** "to Mini, Leni": every name shows its full address on hover and keyboard focus. */
function RecipientNames({
  recipients,
  mine,
  onActivate,
}: {
  recipients: Message["to"];
  mine: Set<string>;
  onActivate: () => void;
}) {
  const { t } = useT();
  const marker = "@@names@@";
  const [before = "", after = ""] = t("reader.to", { names: marker }).split(marker);
  return (
    <>
      {before}
      {recipients.map((address, index) => (
        <Fragment key={`${address.email}-${index}`}>
          {index > 0 && ", "}
          <Tooltip content={fullAddress(address)} onActivate={onActivate}>
            {mine.has(address.email.toLowerCase()) ? t("reader.me") : displayName(address)}
          </Tooltip>
        </Fragment>
      ))}
      {after}
    </>
  );
}

/** Every address of a message in full, each with a button to copy it, and the exact date. */
function AddressDetails({ id, message }: { id: string; message: Message }) {
  const { t, i18n } = useT();
  const labels: Record<AddressRole, string> = {
    from: t("compose.from"),
    replyTo: t("reader.replyTo"),
    to: t("compose.to"),
    cc: t("compose.cc"),
    bcc: t("compose.bcc"),
  };
  const copy = (email: string) =>
    void navigator.clipboard
      .writeText(email)
      .then(() => toast(t("reader.addressCopied"), "success"))
      .catch(() => undefined);
  return (
    <dl
      id={id}
      className="-mt-1 grid animate-fade grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-2xl bg-canvas px-4 py-3 text-[12.5px]"
    >
      {addressRows(message).map((row) => (
        <Fragment key={row.role}>
          <dt className="pt-1 text-muted">{labels[row.role]}</dt>
          <dd className="flex min-w-0 flex-col">
            {row.addresses.map((address, index) => (
              <span key={`${address.email}-${index}`} className="flex min-w-0 items-center gap-1">
                <span className="selectable min-w-0 break-all">{fullAddress(address)}</span>
                <button
                  type="button"
                  aria-label={t("reader.copyAddress", { email: address.email })}
                  title={t("reader.copyAddress", { email: address.email })}
                  onClick={() => copy(address.email)}
                  className="grid size-6 shrink-0 place-items-center rounded-full text-faint hover:bg-pink-tint hover:text-pink-ink focus-visible:shadow-focus focus-visible:outline-none"
                >
                  <Copy className="size-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </dd>
        </Fragment>
      ))}
      <dt className="text-muted">{t("reader.date")}</dt>
      <dd className="selectable">{formatLongDate(message.date, i18n.language)}</dd>
    </dl>
  );
}

/** Less common actions for one message. */
function MessageMenu({ message, accounts, onPrint }: { message: Message; accounts: Account[]; onPrint: () => void }) {
  const { t } = useT();
  const client = useQueryClient();
  const email = message.from.email;
  const domain = useCompanyDomain(email);
  const own = accounts.some((account) => account.email.toLowerCase() === email.toLowerCase());
  const refresh = () => client.invalidateQueries();
  const block = (entry: string) => {
    useUi.getState().selectThread(null);
    void blockSender(entry, message.accountId, [message.id], refresh);
  };
  const items = [
    // No phone web view prints; the system share sheet will do that later.
    ...(nativeMobile ? [] : [{ label: <MenuLabel icon={Printer} text={t("reader.print")} />, onSelect: onPrint }]),
    {
      label: <MenuLabel icon={Download} text={t("reader.saveMessage")} />,
      onSelect: () =>
        void backend()
          .saveMessage(message.id)
          .then((saved) => saved && toast(t("toast.messageSaved"), "success"))
          .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error")),
    },
    ...(own
      ? []
      : [
          { label: <MenuLabel icon={Ban} text={t("reader.blockSender", { email })} />, onSelect: () => block(email) },
          ...(domain
            ? [
                {
                  label: <MenuLabel icon={Ban} text={t("reader.blockDomain", { domain })} />,
                  onSelect: () => block(`@${domain}`),
                },
              ]
            : []),
        ]),
  ];
  return (
    <Menu
      align="end"
      items={items}
      trigger={(menu) => (
        <IconButton
          icon={MoreHorizontal}
          size="sm"
          label={t("reader.more")}
          onClick={menu.toggle}
          aria-haspopup={menu["aria-haspopup"]}
          aria-expanded={menu["aria-expanded"]}
          aria-controls={menu["aria-controls"]}
        />
      )}
    />
  );
}

function MenuLabel({ icon: Icon, text }: { icon: typeof Ban; text: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <Icon className="size-4 shrink-0 text-muted" aria-hidden />
      {text}
    </span>
  );
}

/** Prints one mail from a hidden frame that can't run scripts. */
function printMessage(message: Message, allowRemote: boolean, inlineImages: ReadonlyMap<string, string>) {
  const labels = {
    from: translate("compose.from"),
    to: translate("compose.to"),
    cc: translate("compose.cc"),
    date: translate("reader.date"),
  };
  const frame = document.createElement("iframe");
  // allow-modals lets the print dialog open; without allow-scripts nothing in the mail runs.
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none";
  frame.srcdoc = buildPrintDocument(
    message,
    allowRemote,
    inlineImages,
    labels,
    formatFullDate(message.date, document.documentElement.lang || "de"),
  );
  frame.onload = () => {
    const view = frame.contentWindow;
    if (!view) return;
    view.addEventListener("afterprint", () => frame.remove());
    // Give pictures a moment; then print.
    setTimeout(() => view.print(), 250);
    setTimeout(() => frame.remove(), 10 * 60 * 1000);
  };
  document.body.append(frame);
}
