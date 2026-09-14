import { Fingerprint } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { mobile, nativeAndroid } from "@/backend/mobile";
import { NyuScene } from "@/components/nyu/scenes";
import { Button } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { useSettings } from "@/state/settings";

/**
 * Settings → Security → App lock. Covers UwUMail when it opens and after it
 * was in the background for the chosen time, until the phone confirms it's you.
 */
export function AppLock() {
  const { t } = useT();
  const enabled = useSettings((s) => s.appLock && nativeAndroid);
  const after = useSettings((s) => s.appLockAfter);
  const [locked, setLocked] = useState(enabled);
  const [asking, setAsking] = useState(false);
  const hiddenAt = useRef<number | null>(null);

  const unlock = useCallback(async () => {
    setAsking(true);
    const ok = await mobile.unlock(t("mobile.lock.reason"), t("mobile.lock.prompt"));
    setAsking(false);
    if (ok) setLocked(false);
  }, [t]);

  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
      } else if (hiddenAt.current !== null && Date.now() - hiddenAt.current >= after * 60_000) {
        setLocked(true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, after]);

  // Ask right away instead of making people tap first.
  useEffect(() => {
    if (!locked || !enabled) return;
    const timer = window.setTimeout(() => void unlock(), 0);
    return () => window.clearTimeout(timer);
  }, [locked, enabled, unlock]);

  if (!locked || !enabled) return null;
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-canvas px-8 text-center">
      <NyuScene name="inbox" className="h-auto w-[260px] animate-pop" />
      <p className="text-[18px] font-extrabold">{t("mobile.lock.title")}</p>
      <p className="max-w-[300px] text-[14px] text-muted">{t("mobile.lock.body")}</p>
      <Button variant="primary" size="lg" icon={Fingerprint} busy={asking} onClick={() => void unlock()}>
        {t("mobile.lock.unlock")}
      </Button>
    </div>
  );
}
