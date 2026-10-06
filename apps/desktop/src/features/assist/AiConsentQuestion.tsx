import { Button } from "@uwusuite/design";
import type { AssistFeature } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { answerAiConsent, useAiConsent } from "@/state/aiConsent";

type SentItem = "people" | "subject" | "text" | "draft" | "headers" | "pictures" | "labels";

/** What goes along for these features, in the order the dialog lists it. */
export function sentItems(features: AssistFeature[]): SentItem[] {
  const wanted = new Set(features);
  const items: SentItem[] = ["people", "subject", "text"];
  if (wanted.has("compose")) items.push("draft");
  if (wanted.has("spamCheck")) items.push("headers");
  if (wanted.has("extractEvents")) items.push("pictures");
  if (wanted.has("autoLabels")) items.push("labels");
  return items;
}

/**
 * Asks before the assistant first sends mail to a provider or a UwUMail server (App Review
 * 5.1.2(i)): names where it goes, what is sent and what for, and that it can be taken back.
 * "Not now" is the safe default (also on Escape); see state/aiConsent and `withAiConsent`.
 */
export function AiConsentQuestion() {
  const { t, i18n } = useT();
  const pending = useAiConsent((s) => s.pending);
  const notNow = () => answerAiConsent(false);
  const server = pending?.destination.kind === "uwumailServer";
  const features = (() => {
    if (!pending) return "";
    const names = pending.features.map((feature) => t(`assist.feature.${feature}`));
    try {
      return new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(names);
    } catch {
      return names.join(", ");
    }
  })();

  return (
    <Dialog open={pending !== null} onClose={notNow} width="sm">
      {pending && (
        <div className="flex flex-col gap-3 px-6 pt-2 pb-6">
          <NyuScene name="search" className="w-36 self-center" />
          <h2 className="text-center text-[18px] font-extrabold text-balance">
            {t("assist.consent.title", { name: pending.destination.name })}
          </h2>
          <p className="text-[13px]">
            {t(server ? "assist.consent.introServer" : "assist.consent.intro", {
              name: pending.destination.name,
              host: pending.destination.host,
            })}
          </p>
          <div className="rounded-2xl bg-canvas px-3.5 py-2.5">
            <p className="text-[12.5px] font-semibold">{t("assist.consent.sentTitle")}</p>
            <ul className="mt-1 list-disc pl-5 text-[12.5px] text-muted">
              {sentItems(pending.features).map((item) => (
                <li key={item}>{t(`assist.consent.sent.${item}`)}</li>
              ))}
            </ul>
          </div>
          <p className="text-[12.5px] text-muted">{t("assist.consent.purpose", { features })}</p>
          <p className="text-[12.5px] text-muted">
            {t(server ? "assist.consent.termsServer" : "assist.consent.terms", { name: pending.destination.name })}
          </p>
          <p className="text-[12.5px] text-muted">{t("assist.consent.revoke")}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="ghost" autoFocus onClick={notNow}>
              {t("assist.consent.notNow")}
            </Button>
            <Button variant="primary" onClick={() => answerAiConsent(true)}>
              {t("assist.consent.allow")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
