import { GroupedList, ListRow, ListSection, Screen, type MobilePlatform } from "@uwusuite/design";
import { useState } from "react";
import { ConfirmDiscardDialog } from "@/components/ui/ConfirmDiscardDialog";
import { useT } from "@/i18n";
import { useBackLayer } from "@/lib/backStack";
import { useUi } from "@/state/ui";
import { SettingsSectionBody, useSettingsSections } from "../settings/SettingsDialog";

/**
 * The settings tab on phones: the sections as a grouped list, each one pushed as its own page. The
 * open section is the same `settingsOpen` the desktop dialog uses, so `openSettings("accounts")`
 * from anywhere lands here.
 */
export function MobileSettings({ platform }: { platform: MobilePlatform }) {
  const { t } = useT();
  const sections = useSettingsSections();
  const open = useUi((s) => s.settingsOpen);
  const openSettings = useUi((s) => s.openSettings);
  const closeSettings = useUi((s) => s.closeSettings);
  const dirty = useUi((s) => s.settingsFormDirty);
  const setAddAccountOpen = useUi((s) => s.setAddAccountOpen);
  const [confirming, setConfirming] = useState(false);

  const back = () => {
    if (dirty) setConfirming(true);
    else closeSettings();
  };
  useBackLayer(open !== null, back);

  return (
    <>
      {open === null ? (
        <Screen title={t("settings.title")} largeTitle platform={platform}>
          <GroupedList platform={platform} className="pb-32">
            <ListSection>
              {sections.map(({ id, icon }) => (
                <ListRow
                  key={id}
                  icon={icon}
                  iconTone="pink"
                  title={t(`settings.${id}`)}
                  onClick={() => openSettings(id)}
                />
              ))}
            </ListSection>
            <ListSection>
              <ListRow tone="accent" title={t("nav.addAccount")} onClick={() => setAddAccountOpen(true)} />
            </ListSection>
          </GroupedList>
        </Screen>
      ) : (
        <Screen key={open} title={t(`settings.${open}`)} onBack={back} platform={platform} className="uwu-push-in">
          <div className="px-4 pb-32">
            <SettingsSectionBody section={open} />
          </div>
        </Screen>
      )}
      <ConfirmDiscardDialog
        open={confirming}
        onKeepEditing={() => setConfirming(false)}
        onDiscard={() => {
          setConfirming(false);
          closeSettings();
        }}
      />
    </>
  );
}
