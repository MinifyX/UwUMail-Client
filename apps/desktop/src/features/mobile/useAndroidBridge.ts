import { useEffect, useRef } from "react";
import { mobile, nativeAndroid } from "@/backend/mobile";
import { resolveLanguage, useT } from "@/i18n";
import { useResolvedTheme } from "@/lib/theme";
import { useAccounts } from "@/lib/queries";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";

const ASKED_FOR_NOTIFICATIONS = "uwumail.askedNotifications";

/** Keeps the Android side in step with the UI. Mount once, inside the app. Does nothing elsewhere. */
export function useAndroidBridge() {
  const { t } = useT();
  const theme = useResolvedTheme();
  const tone = useSettings((s) => s.tone);
  const language = useSettings((s) => s.language);
  const onboarded = useSettings((s) => s.onboarded);
  const { data: accounts = [] } = useAccounts();
  const told = useRef(false);

  // Status and navigation bars take the color of the screen behind them.
  useEffect(() => {
    if (!nativeAndroid) return;
    const frame = requestAnimationFrame(() => {
      const styles = getComputedStyle(document.documentElement);
      const background = (
        onboarded ? styles.getPropertyValue("--uwu-surface") : styles.getPropertyValue("--uwu-canvas")
      ).trim();
      void mobile.setSystemBars(theme === "dark", background);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, onboarded]);

  useEffect(() => {
    void mobile.setPrefs(resolveLanguage(language), tone);
  }, [language, tone]);

  // The first screen is drawn: Nyu's splash can go.
  useEffect(() => {
    if (told.current) return;
    told.current = true;
    requestAnimationFrame(() => void mobile.uiReady());
  }, []);

  // Once there's a mailbox, ask for permission to show new mail (Android 13+ asks once).
  useEffect(() => {
    if (!nativeAndroid || accounts.length === 0) return;
    try {
      if (localStorage.getItem(ASKED_FOR_NOTIFICATIONS)) return;
      localStorage.setItem(ASKED_FOR_NOTIFICATIONS, "1");
    } catch {
      // Ask anyway.
    }
    void mobile.requestNotifications();
  }, [accounts.length]);

  // Shares, mailto: links and tapped notifications.
  useEffect(() => {
    if (!nativeAndroid) return;
    const take = async () => {
      const action = await mobile.takeLaunchAction();
      if (!action) return;
      const ui = useUi.getState();
      if (action.kind === "open") {
        ui.setFolderDrawerOpen(false);
        ui.selectThread(action.threadId);
        return;
      }
      ui.openCompose({ mode: "new", ...action.draft, attachments: action.attachments });
      if (action.tooBig.length > 0) toast(t("mobile.share.tooBig", { names: action.tooBig.join(", ") }), "error");
    };
    void take();
    return mobile.onLaunchAction(() => void take());
  }, [t]);
}
