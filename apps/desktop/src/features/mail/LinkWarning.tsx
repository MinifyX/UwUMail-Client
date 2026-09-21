import clsx from "clsx";
import { AlertTriangle, Copy, LockOpen, Route } from "lucide-react";
import { useState } from "react";
import type { Address } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { formatAddress } from "@/lib/format";
import { urlParts, visibleText, type LinkCheck } from "@/lib/links";
import { registrableDomain } from "@/lib/domains";
import { openCheckedLink, useLinks } from "@/state/links";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";

/**
 * A modal dialog focuses the first focusable element when it opens (here that would be the
 * checkbox), unless an element carries the autofocus attribute. React's autoFocus prop alone
 * doesn't set it.
 */
export function markAutofocus(element: HTMLElement | null) {
  element?.setAttribute("autofocus", "");
}

/** Copies the link as written in the mail. */
export function copyLink(check: LinkCheck, message: string) {
  void navigator.clipboard
    .writeText(check.href)
    .then(() => toast(message, "success"))
    .catch(() => undefined);
}

/**
 * Addresses are shown letter by letter: Manrope joins "--" into one dash, which would turn
 * "xn--" into "xn-" and hide exactly what the reader needs to see.
 */
const EXACT = "[font-variant-ligatures:none] [font-feature-settings:'calt'_0,'liga'_0]";

/** A web address with the registrable domain in bold and the rest in a scrollable box. */
export function LinkAddress({ href, compact = false }: { href: string; compact?: boolean }) {
  const parts = urlParts(href);
  if (!parts) return <span className="font-mono break-all">{visibleText(href)}</span>;
  const host = (
    <span className={clsx("break-all", EXACT)}>
      <span className="text-muted">{parts.scheme}</span>
      {parts.userinfo && <span className="text-danger line-through">{parts.userinfo}</span>}
      <span>{parts.subdomain}</span>
      <span className="font-extrabold">{parts.domain}</span>
      <span className="text-muted">{parts.port}</span>
    </span>
  );
  if (compact) {
    return (
      <span className="min-w-0 truncate">
        {host}
        <span className="text-muted">{parts.rest}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="text-[14px]">{host}</span>
      {parts.rest !== "/" && (
        <span className="selectable block max-h-24 overflow-y-auto rounded-lg bg-surface px-2 py-1 font-mono text-[11.5px] break-all text-muted">
          {parts.rest}
        </span>
      )}
    </span>
  );
}

/** What the dialog and the long-press sheet say about a link besides its address. */
export function LinkFacts({ check }: { check: LinkCheck }) {
  const { t } = useT();
  const redirect = check.redirect;
  const domain = check.host ? registrableDomain(check.host) : "";
  return (
    <>
      {check.misleading && (
        <div className="w-full rounded-2xl bg-danger-tint px-4 py-3 text-left text-[13px]">
          <p className="mb-1.5 font-bold text-danger">{t("link.warningBody")}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">{t("link.shown")}</dt>
            <dd className="font-semibold break-all">{visibleText(check.misleading.shown)}</dd>
            <dt className="text-muted">{t("link.actual")}</dt>
            <dd className={clsx("font-extrabold break-all text-danger", EXACT)}>
              {visibleText(check.misleading.actual)}
            </dd>
          </dl>
        </div>
      )}
      {check.unicodeHost && (
        <p
          className={clsx(
            "flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-[12.5px]",
            check.lookalike ? "bg-danger-tint text-danger" : "bg-canvas text-muted",
          )}
        >
          {check.lookalike && <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />}
          <span className="min-w-0">
            {t("link.unicodeHost")}:{" "}
            <span className={clsx("font-bold break-all", EXACT)}>{visibleText(check.unicodeHost)}</span>
            {check.lookalike && <span className="block">{t("link.lookalike")}</span>}
          </span>
        </p>
      )}
      {check.userinfo && (
        <Note tone="danger" icon={AlertTriangle}>
          {t("link.userinfo", { domain })}
        </Note>
      )}
      {check.insecure && (
        <Note tone="warning" icon={LockOpen}>
          {t("link.insecure")}
        </Note>
      )}
      {redirect && (
        <div className="flex w-full items-start gap-2 rounded-xl bg-canvas px-3 py-2 text-left text-[12.5px]">
          <Route className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            {redirect.target && (
              <>
                <span className="font-semibold text-muted">{t("link.redirectsTo")}</span>
                <LinkAddress href={redirect.target} />
              </>
            )}
            {redirect.hidden && (
              <span className="text-muted">
                {t(redirect.hidden.service === "tracking" ? "link.tracking" : "link.service", {
                  host: visibleText(redirect.hidden.host),
                })}
                {". "}
                {t("link.hiddenTarget")}
              </span>
            )}
          </span>
        </div>
      )}
    </>
  );
}

function Note({
  tone,
  icon: Icon,
  children,
}: {
  tone: "danger" | "warning";
  icon: typeof AlertTriangle;
  children: string;
}) {
  return (
    <p
      className={clsx(
        "flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-[12.5px]",
        tone === "danger" ? "bg-danger-tint text-danger" : "bg-warning-tint text-warning",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Recipients({ label, list }: { label: string; list: Address[] }) {
  if (list.length === 0) return null;
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold break-all">
        {list.map((address) => visibleText(formatAddress(address))).join(", ")}
      </dd>
    </>
  );
}

/** Whether a link needs the careful version of the dialog, with "Don't open" focused. */
export function isRisky(check: LinkCheck) {
  return Boolean(check.misleading || check.lookalike || check.userinfo || check.insecure);
}

/** Asks before a link from a mail opens: shows where it really goes, and warns when it hides that. */
export function LinkWarning() {
  const pending = useLinks((s) => s.pending);
  const clear = useLinks((s) => s.clear);

  return (
    <Dialog open={pending !== null} onClose={clear} width="sm">
      {pending && <LinkQuestion key={pending.href} check={pending} onDone={clear} />}
    </Dialog>
  );
}

function LinkQuestion({ check, onDone }: { check: LinkCheck; onDone: () => void }) {
  const { t } = useT();
  const rememberLinkDomain = useSettings((s) => s.rememberLinkDomain);
  const [remember, setRemember] = useState(false);
  const risky = isRisky(check);
  const mail = check.kind === "mail" ? check.mailto : null;

  const open = () => {
    onDone();
    if (remember && check.rememberable) {
      rememberLinkDomain(check.rememberable);
      toast(t("link.remembered", { domain: check.rememberable }), "success");
    }
    openCheckedLink(check);
  };

  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-2 pb-6 text-center">
      <NyuScene name="search" className="w-36" />
      <h2 className="text-[18px] font-extrabold text-balance break-keep">
        {check.misleading ? t("link.warningTitle") : mail ? t("link.mailTitle") : t("link.confirmTitle")}
      </h2>
      {!check.misleading && (
        <p className="text-[13px] text-muted">{mail ? t("link.mailBody") : t("link.confirmBody")}</p>
      )}
      {mail ? (
        <dl className="grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 rounded-2xl bg-canvas px-4 py-3 text-left text-[13px]">
          <Recipients label={t("compose.to")} list={mail.to} />
          <Recipients label={t("compose.cc")} list={mail.cc} />
          <Recipients label={t("compose.bcc")} list={mail.bcc} />
          {mail.subject && (
            <>
              <dt className="text-muted">{t("compose.subject")}</dt>
              <dd className="break-words">{visibleText(mail.subject)}</dd>
            </>
          )}
        </dl>
      ) : (
        <div className="w-full rounded-2xl bg-canvas px-4 py-3 text-left">
          <LinkAddress href={check.href} />
        </div>
      )}
      <LinkFacts check={check} />
      {check.rememberable && (
        <label className="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-1 text-left text-[13px]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.currentTarget.checked)}
            className="size-4 shrink-0 accent-pink-solid"
          />
          <span className="min-w-0 break-words">{t("link.remember", { domain: check.rememberable })}</span>
        </label>
      )}
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        {risky ? (
          <>
            <Button variant="primary" autoFocus ref={markAutofocus} onClick={onDone}>
              {t("link.dontOpen")}
            </Button>
            <Button variant="ghost" onClick={open}>
              {t("link.openAnyway")}
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" autoFocus ref={markAutofocus} onClick={open}>
              {mail ? t("link.compose") : t("link.open")}
            </Button>
            <Button variant="secondary" onClick={onDone}>
              {t("common.cancel")}
            </Button>
          </>
        )}
        {!mail && (
          <Button variant="ghost" icon={Copy} onClick={() => copyLink(check, t("link.copied"))}>
            {t("link.copy")}
          </Button>
        )}
      </div>
    </div>
  );
}
