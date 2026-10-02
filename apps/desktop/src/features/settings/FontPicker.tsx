import clsx from "clsx";
import { useT } from "@/i18n";
import { FONT_CHOICES, FONT_NAMES, FONT_STACKS, SENDER_FONT_CHOICES, type FontChoice } from "@/lib/fonts";
import { Segmented } from "@/components/ui/Field";
import { useSettings } from "@/state/settings";
import { Row } from "./Row";

function fontName(choice: FontChoice, system: string) {
  return choice === "system" ? system : FONT_NAMES[choice];
}

/** Settings → Appearance → Font: every choice shown in itself. */
export function FontPicker() {
  const { t } = useT();
  const font = useSettings((s) => s.font);
  const update = useSettings((s) => s.update);
  return (
    <Row label={t("settings.font")} description={t("settings.fontDesc")}>
      <div role="radiogroup" aria-label={t("settings.font")} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {FONT_CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={font === choice}
            onClick={() => update({ font: choice })}
            style={{ fontFamily: FONT_STACKS[choice] }}
            className={clsx(
              "flex flex-col items-start gap-0.5 rounded-control border px-3 py-2 text-left transition-colors",
              font === choice
                ? "border-pink bg-pink-tint text-pink-ink"
                : "border-hairline text-ink hover:border-line hover:bg-canvas",
            )}
          >
            <span className="text-[15px] font-semibold">{fontName(choice, t("font.system"))}</span>
            <span className="text-[13px] text-muted tabular-nums">{t("font.sample")}</span>
          </button>
        ))}
      </div>
    </Row>
  );
}

/** Settings → Reading → Sender fonts. */
export function SenderFontsSetting() {
  const { t } = useT();
  const senderFonts = useSettings((s) => s.senderFonts);
  const update = useSettings((s) => s.update);
  return (
    <Row label={t("settings.senderFonts")} description={t("settings.senderFontsDesc")}>
      <Segmented
        label={t("settings.senderFonts")}
        value={senderFonts}
        onChange={(value) => update({ senderFonts: value })}
        options={SENDER_FONT_CHOICES.map((value) => ({
          value,
          label: t(value === "replace" ? "settings.senderFontsReplace" : "settings.senderFontsKeep"),
        }))}
      />
    </Row>
  );
}
