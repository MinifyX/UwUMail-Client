import clsx from "clsx";
import { ArrowLeft, Check } from "lucide-react";
import { useState, type ReactNode } from "react";
import { backend } from "@/backend/backend";
import { Button } from "@/components/ui/Button";
import { LogoSymbol } from "@/components/ui/Logo";
import { i18n, useT } from "@/i18n";
import { toast } from "@/state/toasts";
import { useSettings, type LayoutMode, type Tone } from "@/state/settings";
import { AccountSetup } from "../accounts/AccountSetup";

const STEPS = ["welcome", "layout", "tone", "account", "done"] as const;
type Step = (typeof STEPS)[number];

function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  preview,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  preview: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={clsx(
        "relative flex flex-1 flex-col gap-3 rounded-[20px] border-2 bg-surface p-4 text-left transition-[border,transform] hover:-translate-y-0.5",
        selected ? "border-pink" : "border-line hover:border-pink-tint-strong",
      )}
    >
      {selected && (
        <span className="absolute top-3 right-3 grid size-6 animate-pop place-items-center rounded-full bg-pink text-white">
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
      )}
      <div className="h-28 overflow-hidden rounded-xl bg-canvas p-2.5" aria-hidden>
        {preview}
      </div>
      <span>
        <span className="block text-[15px] font-bold">{title}</span>
        <span className="block text-[13px] text-muted">{description}</span>
      </span>
    </button>
  );
}

const bar = "rounded-full bg-line";

function SimplePreview() {
  return (
    <div className="flex h-full gap-2">
      <div className="flex w-1/2 flex-col gap-1.5 rounded-lg bg-surface p-2">
        <div className="flex gap-1">
          <span className="h-2 w-6 rounded-full bg-pink-tint-strong" />
          <span className={clsx(bar, "h-2 w-6")} />
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className={clsx("size-4 shrink-0 rounded-full", i === 0 ? "bg-pink-tint-strong" : "bg-line")} />
            <span className="flex flex-1 flex-col gap-1">
              <span className={clsx(bar, "h-1.5 w-3/4")} />
              <span className={clsx(bar, "h-1.5 w-1/2 opacity-60")} />
            </span>
          </div>
        ))}
      </div>
      <div className="flex w-1/2 flex-col gap-1.5 rounded-lg bg-surface p-2">
        <span className={clsx(bar, "h-2 w-2/3")} />
        <span className={clsx(bar, "h-1.5 w-full opacity-60")} />
        <span className={clsx(bar, "h-1.5 w-5/6 opacity-60")} />
        <span className={clsx(bar, "h-1.5 w-4/6 opacity-60")} />
      </div>
    </div>
  );
}

function ProPreview() {
  return (
    <div className="flex h-full gap-1.5">
      <div className="flex w-1/5 flex-col gap-1.5 rounded-lg bg-surface p-1.5">
        <span className="h-2 rounded-full bg-pink" />
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={clsx("h-1.5 rounded-full", i === 0 ? "bg-pink-tint-strong" : "bg-line")} />
        ))}
      </div>
      <div className="flex w-2/5 flex-col gap-[5px] rounded-lg bg-surface p-1.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={clsx("h-1.5 rounded-full", i === 1 ? "bg-pink-tint-strong" : "bg-line")} />
        ))}
      </div>
      <div className="flex w-2/5 flex-col gap-1.5 rounded-lg bg-surface p-1.5">
        <span className={clsx(bar, "h-2 w-2/3")} />
        <span className={clsx(bar, "h-1.5 w-full opacity-60")} />
        <span className={clsx(bar, "h-1.5 w-5/6 opacity-60")} />
      </div>
    </div>
  );
}

function TonePreview({ tone }: { tone: Tone }) {
  const sample = i18n.getFixedT(null, tone)("list.empty.inbox.title");
  return (
    <div className="flex h-full items-center justify-center">
      <span className="rounded-2xl bg-surface px-3 py-2 text-center text-[12.5px] font-semibold text-ink shadow-sm">
        {sample}
      </span>
    </div>
  );
}

export function Onboarding() {
  const { t } = useT();
  const settings = useSettings();
  const [step, setStep] = useState<Step>("welcome");
  const index = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);
  const finish = () => settings.update({ onboarded: true });

  return (
    <main className="h-full overflow-y-auto bg-canvas">
      <div
        aria-hidden
        className="pointer-events-none fixed -top-40 -right-40 size-[520px] rounded-full bg-pink-tint opacity-70 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed -bottom-48 -left-40 size-[460px] rounded-full bg-pink-tint-strong opacity-40 blur-3xl"
      />

      {/* min-h-full + centering on an inner wrapper keeps tall steps scrollable from the top. */}
      <div className="flex min-h-full items-center justify-center p-6">
        <div
          key={step}
          className="relative flex w-full max-w-[620px] animate-slide-up flex-col gap-6 rounded-[28px] border border-line bg-surface p-8 shadow-float"
        >
          {step !== "welcome" && step !== "done" && (
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={back}>
                {t("onboarding.back")}
              </Button>
              <div className="flex gap-1.5" aria-label={t("onboarding.step", { current: index, total: 3 })}>
                {[1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={clsx(
                      "h-1.5 rounded-full transition-all",
                      i === index ? "w-6 bg-pink" : i < index ? "w-1.5 bg-pink" : "w-1.5 bg-line",
                    )}
                  />
                ))}
              </div>
            </div>
          )}

          {step === "welcome" && (
            <div className="flex flex-col items-center gap-5 py-6 text-center">
              <LogoSymbol className="h-24 w-auto animate-wiggle" title="UwUMail" />
              <div className="flex flex-col gap-2">
                <h1 className="text-[28px] leading-tight font-extrabold tracking-[-0.02em]">
                  {t("onboarding.welcomeTitle")}
                </h1>
                <p className="text-[15px] text-muted">{t("onboarding.welcomeBody")}</p>
              </div>
              <Button variant="primary" size="lg" onClick={next}>
                {t("onboarding.start")}
              </Button>
            </div>
          )}

          {step === "layout" && (
            <>
              <header className="flex flex-col gap-1">
                <h1 className="text-[22px] font-extrabold">{t("onboarding.layoutTitle")}</h1>
                <p className="text-[14px] text-muted">{t("onboarding.layoutBody")}</p>
              </header>
              <div role="radiogroup" className="flex flex-col gap-3 sm:flex-row">
                {(["simple", "pro"] as LayoutMode[]).map((mode) => (
                  <ChoiceCard
                    key={mode}
                    selected={settings.layout === mode}
                    onSelect={() => settings.update({ layout: mode })}
                    title={t(`layout.${mode}.name`)}
                    description={t(`layout.${mode}.desc`)}
                    preview={mode === "simple" ? <SimplePreview /> : <ProPreview />}
                  />
                ))}
              </div>
              <Button variant="primary" onClick={next} className="self-end">
                {t("onboarding.next")}
              </Button>
            </>
          )}

          {step === "tone" && (
            <>
              <header className="flex flex-col gap-1">
                <h1 className="text-[22px] font-extrabold">{t("onboarding.toneTitle")}</h1>
                <p className="text-[14px] text-muted">{t("onboarding.toneBody")}</p>
              </header>
              <div role="radiogroup" className="flex flex-col gap-3 sm:flex-row">
                {(["playful", "neutral"] as Tone[]).map((tone) => (
                  <ChoiceCard
                    key={tone}
                    selected={settings.tone === tone}
                    onSelect={() => settings.update({ tone })}
                    title={t(`tone.${tone}.name`)}
                    description={t(`tone.${tone}.desc`)}
                    preview={<TonePreview tone={tone} />}
                  />
                ))}
              </div>
              <Button variant="primary" onClick={next} className="self-end">
                {t("onboarding.next")}
              </Button>
            </>
          )}

          {step === "account" && (
            <>
              <header className="flex flex-col gap-1">
                <h1 className="text-[22px] font-extrabold">{t("onboarding.accountTitle")}</h1>
                <p className="text-[14px] text-muted">{t("onboarding.accountBody")}</p>
              </header>
              <AccountSetup
                onDone={(account) => {
                  toast(t("toast.accountAdded", { email: account.email }), "success");
                  next();
                }}
                footer={
                  <Button variant="ghost" size="sm" onClick={next}>
                    {backend().kind === "demo" ? t("onboarding.skipDemo") : t("onboarding.skip")}
                  </Button>
                }
              />
            </>
          )}

          {step === "done" && (
            <div className="flex flex-col items-center gap-5 py-6 text-center">
              <LogoSymbol className="h-20 w-auto animate-pop" />
              <div className="flex flex-col gap-2">
                <h1 className="text-[26px] font-extrabold tracking-[-0.02em]">{t("onboarding.doneTitle")}</h1>
                <p className="text-[15px] text-muted">{t("onboarding.doneBody")}</p>
              </div>
              <Button variant="primary" size="lg" onClick={finish}>
                {t("onboarding.open")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
