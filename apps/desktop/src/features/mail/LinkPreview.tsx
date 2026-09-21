import { AlertTriangle, Route } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { urlParts, visibleText, type LinkCheck } from "@/lib/links";
import { requestOpenChecked, useLinks } from "@/state/links";
import { copyLink, LinkAddress, LinkFacts, markAutofocus } from "./LinkWarning";

/** Host and path of a redirect target, short enough for one line. */
function shortTarget(href: string) {
  const parts = urlParts(href);
  return parts ? `${parts.subdomain}${parts.domain}${parts.rest === "/" ? "" : parts.rest}` : visibleText(href);
}

function StatusExtra({ check }: { check: LinkCheck }) {
  const { t } = useT();
  if (check.misleading) {
    return (
      <span className="flex shrink-0 items-center gap-1 font-bold">
        <AlertTriangle className="size-3.5" aria-hidden />
        {t("link.otherTarget")}
      </span>
    );
  }
  const redirect = check.redirect;
  if (!redirect) return null;
  const text = redirect.target
    ? t("link.statusRedirect", { target: shortTarget(redirect.target) })
    : t(redirect.hidden?.service === "tracking" ? "link.tracking" : "link.service", {
        host: visibleText(redirect.hidden?.host ?? ""),
      });
  return (
    <span className="flex min-w-0 items-center gap-1 text-muted">
      <Route className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * The status line at the bottom of the reader while a link in a mail is hovered or focused, like
 * a browser's: the full address with the domain in bold, and whether it goes elsewhere.
 */
export function LinkStatus() {
  const hover = useLinks((s) => s.hover);
  if (!hover) return null;
  const { check, area } = hover;
  const danger = Boolean(check.misleading || check.lookalike);
  return (
    <div
      role="status"
      style={{ left: area.left + 8, bottom: area.bottom + 8, maxWidth: Math.max(area.width - 16, 160) }}
      className={
        "pointer-events-none fixed z-40 flex max-w-full min-w-0 flex-col gap-0.5 rounded-xl border px-3 py-1.5 text-[12px] shadow-float " +
        (danger ? "border-danger/40 bg-danger-tint text-danger" : "border-hairline bg-elevated text-ink")
      }
    >
      <span className="flex min-w-0">
        {check.kind === "mail" ? (
          <span className="truncate">{visibleText(check.href)}</span>
        ) : (
          <LinkAddress href={check.href} compact />
        )}
      </span>
      {(check.misleading || check.redirect) && <StatusExtra check={check} />}
    </div>
  );
}

/** A link held down on a touch screen: where it goes, then open, copy or leave it. */
export function LinkSheet() {
  const { t } = useT();
  const sheet = useLinks((s) => s.sheet);
  const close = () => useLinks.setState({ sheet: null });
  return (
    <Dialog
      open={sheet !== null}
      onClose={close}
      width="sm"
      className="max-[699px]:mb-0 max-[699px]:w-full max-[699px]:max-w-none max-[699px]:rounded-b-none"
    >
      {sheet && (
        <div className="flex flex-col gap-3 px-5 pt-4 pb-6">
          <h2 className="text-[15px] font-extrabold">{t("link.sheetTitle")}</h2>
          <div className="rounded-2xl bg-canvas px-4 py-3 text-left">
            {sheet.kind === "mail" ? (
              <span className="font-mono text-[12.5px] break-all">{visibleText(sheet.href)}</span>
            ) : (
              <LinkAddress href={sheet.href} />
            )}
          </div>
          <LinkFacts check={sheet} />
          <div className="flex flex-col gap-2 pt-1">
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                close();
                requestOpenChecked(sheet);
              }}
            >
              {sheet.kind === "mail" ? t("link.compose") : t("link.open")}
            </Button>
            <Button
              size="lg"
              onClick={() => {
                close();
                copyLink(sheet, t("link.copied"));
              }}
            >
              {t("link.copyShort")}
            </Button>
            <Button size="lg" variant="ghost" autoFocus ref={markAutofocus} onClick={close}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
