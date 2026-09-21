import { useEffect } from "react";
import { Toaster } from "@/components/ui/Toaster";
import { MailShell } from "@/features/shell/MailShell";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { DeleteForeverQuestion } from "@/features/mail/DeleteForeverQuestion";
import { LinkWarning } from "@/features/mail/LinkWarning";
import { AppLock } from "@/features/mobile/AppLock";
import { useMobileBridge } from "@/features/mobile/useMobileBridge";
import { UpdateHint } from "@/features/updates/UpdateHint";
import { i18n, resolveLanguage } from "@/i18n";
import { useApplyTheme } from "@/lib/theme";
import { useSettings } from "@/state/settings";

export function App() {
  const onboarded = useSettings((s) => s.onboarded);
  const language = useSettings((s) => s.language);
  useApplyTheme();
  useMobileBridge();

  useEffect(() => {
    const resolved = resolveLanguage(language);
    void i18n.changeLanguage(resolved);
    document.documentElement.lang = resolved;
  }, [language]);

  return (
    <>
      {onboarded ? <MailShell /> : <Onboarding />}
      <UpdateHint />
      <LinkWarning />
      <DeleteForeverQuestion />
      <Toaster />
      <AppLock />
    </>
  );
}
