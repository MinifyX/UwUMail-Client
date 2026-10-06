import { useEffect } from "react";
import { UwuLabels } from "@uwusuite/design";
import { useApplyNyuLevel } from "@/components/nyu/level";
import { NyuStage } from "@/components/nyu/NyuStage";
import { Toaster } from "@/components/ui/Toaster";
import { MailShell } from "@/features/shell/MailShell";
import { useMacLifecycle, useMacMenu } from "@/features/shell/useMacShell";
import { WindowTitleBar } from "@/features/shell/WindowTitleBar";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { DeleteForeverQuestion } from "@/features/mail/DeleteForeverQuestion";
import { DangerousFileQuestion } from "@/features/attachments/DangerousFileQuestion";
import { AiConsentQuestion } from "@/features/assist/AiConsentQuestion";
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
  useMacLifecycle();
  // Before the first account; MailShell fills the menu bar with the mail's commands afterwards.
  useMacMenu(null, !onboarded);

  useEffect(() => {
    const resolved = resolveLanguage(language);
    void i18n.changeLanguage(resolved);
    document.documentElement.lang = resolved;
  }, [language]);

  return (
    // The words the package's components say themselves (the dialogs' close button, the title bar).
    <UwuLabels labels={resolveLanguage(language)}>
      <div className="flex h-full flex-col">
        <WindowTitleBar />
        <div className="relative min-h-0 flex-1">
          <BehindLock>
            {onboarded ? <MailShell /> : <Onboarding />}
            <UpdateHint />
            <LinkWarning />
            <LinkSheet />
            <LinkStatus />
            <DeleteForeverQuestion />
            <FolderDialogs />
            <DangerousFileQuestion />
            <AiConsentQuestion />
            <SharedMailboxDialogs />
            <NyuStage />
            <Toaster />
          </BehindLock>
          <AppLock />
        </div>
      </div>
    </UwuLabels>
  );
}
