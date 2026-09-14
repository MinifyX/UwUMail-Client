import { create } from "zustand";
import { isOpenableLink, misleadingLink, type Misleading } from "@/lib/links";
import { openExternal } from "@/lib/platform";
import { toast } from "@/state/toasts";
import { i18n } from "@/i18n";

interface LinkState {
  /** A link that needs a second look before it opens. */
  pending: (Misleading & { url: string }) | null;
  clear: () => void;
}

export const useLinks = create<LinkState>()((set) => ({
  pending: null,
  clear: () => set({ pending: null }),
}));

export async function openLinkNow(url: string) {
  try {
    await openExternal(url);
  } catch (reason) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    toast(i18n.t("link.failed", { reason: detail }), "error");
  }
}

/** Opens a link from a mail, or asks first when its text names another address. */
export function requestOpenLink(url: string, text: string) {
  if (!isOpenableLink(url)) return;
  const misleading = misleadingLink(url, text);
  if (misleading) useLinks.setState({ pending: { ...misleading, url } });
  else void openLinkNow(url);
}
