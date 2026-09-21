import { create } from "zustand";
import { checkLink, needsConfirmation, type LinkCheck } from "@/lib/links";
import { openExternal } from "@/lib/platform";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { translate } from "@/i18n";

/** Where the status line for a hovered link sits: the bottom of the reader, in window pixels. */
export interface ReaderArea {
  left: number;
  bottom: number;
  width: number;
}

interface LinkState {
  /** A link from a mail waiting for the reader's go-ahead. */
  pending: LinkCheck | null;
  /** The link under the pointer or the keyboard focus in a mail. */
  hover: { check: LinkCheck; area: ReaderArea } | null;
  /** A link held down on a touch screen. */
  sheet: LinkCheck | null;
  clear: () => void;
}

export const useLinks = create<LinkState>()((set) => ({
  pending: null,
  hover: null,
  sheet: null,
  clear: () => set({ pending: null }),
}));

export async function openLinkNow(url: string) {
  try {
    await openExternal(url);
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    toast(translate("link.failed", { reason: detail }), "error");
  }
}

/** Opens a checked link: web links in the browser, mail links in UwUMail's own composer. */
export function openCheckedLink(check: LinkCheck) {
  if (check.kind === "mail") {
    if (check.mailto) useUi.getState().openCompose({ mode: "new", ...check.mailto });
    return;
  }
  void openLinkNow(check.href);
}

export type LinkRequest = "opened" | "asked" | "ignored";

/**
 * Opens a link from a mail, or asks first (see needsConfirmation in lib/links). Anything but
 * web and mail links is ignored; in-page anchors quietly, everything else with a short note.
 */
export function requestOpenLink(url: string, text: string): LinkRequest {
  const check = checkLink(url, text);
  if (!check) {
    const trimmed = url.trim();
    if (trimmed && !trimmed.startsWith("#")) toast(translate("link.unsupported"), "info");
    return "ignored";
  }
  return requestOpenChecked(check);
}

/** The same rules for a link that was already checked, e.g. from the long-press sheet. */
export function requestOpenChecked(check: LinkCheck): LinkRequest {
  const { linkConfirm, linkDomains } = useSettings.getState();
  if (needsConfirmation(check, { confirm: linkConfirm, domains: linkDomains })) {
    useLinks.setState({ pending: check });
    return "asked";
  }
  openCheckedLink(check);
  return "opened";
}
