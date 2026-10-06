import { useEffect } from "react";
import { UwuLabels } from "@uwusuite/design";
import { useApplyNyuLevel } from "@/components/nyu/level";
import { NyuStage } from "@/components/nyu/NyuStage";
import { Toaster } from "@/components/ui/Toaster";
import { MailShell } from "@/features/shell/MailShell";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { DeleteForeverQuestion } from "@/features/mail/DeleteForeverQuestion";
import { DangerousFileQuestion } from "@/features/attachments/DangerousFileQuestion";
import { FolderDialogs } from "@/features/mail/FolderDialogs";
import { SharedMailboxDialogs } from "@/features/accounts/SharedMailboxDialogs";
import { LinkSheet, LinkStatus } from "@/features/mail/LinkPreview";
import { LinkWarning } from "@/features/mail/LinkWarning";
import { AppLock, BehindLock } from "@/features/mobile/AppLock";
import { useMobileBridge } from "@/features/mobile/useMobileBridge";
import { UpdateHint } from "@/features/updates/UpdateHint";
import { i18n, resolveLanguage } from "@/i18n";
import { useUpdateSettings } from "@/lib/queries";
import { useApplyTheme } from "@/lib/theme";
import { useSettings } from "@/state/settings";

export function App() {
  const onboarded = useSettings((s) => s.onboarded);
  const language = useSettings((s) => s.language);
  useApplyTheme();
  useApplyNyuLevel();
  useMobileBridge();
  useUpdateSettings();

  useEffect(() => {
    const resolved = resolveLanguage(language);
    void i18n.changeLanguage(resolved);
    document.documentElement.lang = resolved;
  }, [language]);

  return (
    // The words the package's components say themselves (the dialogs' close button).
    <UwuLabels labels={resolveLanguage(language)}>
      <BehindLock>
        {onboarded ? <MailShell /> : <Onboarding />}
        <UpdateHint />
        <LinkWarning />
        <LinkSheet />
        <LinkStatus />
        <DeleteForeverQuestion />
        <FolderDialogs />
        <DangerousFileQuestion />
        <SharedMailboxDialogs />
        <NyuStage />
        <Toaster />
      </BehindLock>
      <AppLock />
    </UwuLabels>
  );
}
