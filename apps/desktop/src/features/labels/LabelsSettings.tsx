import { Tags, Undo2 } from "lucide-react";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { AssistLabelLogEntry, AssistScope } from "@/backend/types";
import { Button } from "@uwusuite/design";
import { useT } from "@/i18n";
import { formatLongDate } from "@/lib/format";
import { useAccounts } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { chipStyle, labelReason } from "../assist/labels";
import { LabelSettings } from "../assist/settings/LabelSettings";
import { Section } from "../assist/settings/common";
import {
  AssistScopeProvider,
  assistErrorText,
  useAssistLabels,
  useAssistScope,
  useAssistScopes,
  useLabelLogList,
} from "../assist/useAssist";

/**
 * Settings → Labels: per UwUMail account (its server keeps them) and for this device (the labels
 * of every other mailbox), the labels with what puts them on by themselves, and what did lately.
 * Labels work without any AI provider.
 */
export function LabelsSettings() {
  const { t } = useT();
  const { data: scopes = [] } = useAssistScopes();
  const { data: accounts = [] } = useAccounts();
  const nameOf = (scope: AssistScope) =>
    scope.kind === "device"
      ? t("labels.settings.device")
      : (accounts.find((account) => account.id === scope.accountId)?.email ?? scope.accountId ?? scope.id);
  return (
    <div className="flex flex-col gap-5 py-4">
      <div className="flex gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-pink-tint text-pink">
          <Tags className="size-5" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-semibold">{t("labels.settings.title")}</p>
          <p className="text-[13px] text-muted">{t("labels.settings.intro")}</p>
        </div>
      </div>
      {scopes.map((scope) => (
        <AssistScopeProvider key={scope.id} scope={scope.id}>
          <section className="flex flex-col gap-4 rounded-2xl border border-line p-3.5" aria-label={nameOf(scope)}>
            {scopes.length > 1 && (
              <div>
                <p className="truncate text-sm font-semibold">{nameOf(scope)}</p>
                <p className="text-[12.5px] text-muted">
                  {scope.kind === "device" ? t("labels.settings.deviceDesc") : t("labels.settings.serverDesc")}
                </p>
              </div>
            )}
            <LabelSettings options={scope.options} />
            <LabelLog />
          </section>
        </AssistScopeProvider>
      ))}
    </div>
  );
}

const SOURCES = ["ai", "rule", "sender", "detector", "classifier", "similar"] as const;

/** The labels put on lately by themselves, newest first: who, why, and undo. */
function LabelLog() {
  const { t, i18n } = useT();
  const scope = useAssistScope();
  const { data: labels = [] } = useAssistLabels();
  const [limit, setLimit] = useState(20);
  const { data: log = [], isPending } = useLabelLogList(limit + 1);
  const [busy, setBusy] = useState<string | null>(null);
  const closeSettings = useUi((s) => s.closeSettings);
  const selectThread = useUi((s) => s.selectThread);
  const shown = log.slice(0, limit);

  const undo = (entry: AssistLabelLogEntry) => {
    setBusy(entry.id);
    backend()
      .undoAssistLabels(scope, [entry.id])
      .then(() => toast(t("assist.labels.undone", { name: entry.name }), "success"))
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => setBusy(null));
  };

  return (
    <Section title={t("labels.log.title")} description={t("labels.log.description")}>
      {!isPending && shown.length === 0 && <p className="text-[13px] text-muted">{t("labels.log.empty")}</p>}
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {shown.map((entry) => {
            const label = labels.find((each) => each.id === entry.labelId);
            const source = SOURCES.includes(entry.source) ? entry.source : "ai";
            return (
              <li key={entry.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-xl bg-canvas px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span
                      style={chipStyle(label?.color ?? null)}
                      className="inline-flex h-5 items-center rounded-full border border-line px-2 text-[11px] font-semibold"
                    >
                      {entry.name}
                    </span>
                    <span className="text-[11px] font-bold tracking-wide text-muted uppercase">
                      {t(`labels.source.${source}`)}
                    </span>
                    {entry.undone && <span className="text-[11px] text-faint">{t("labels.log.undone")}</span>}
                  </p>
                  <p className="text-[12.5px] break-words">{labelReason(entry, t)}</p>
                  <p className="text-[11px] text-faint">
                    {[
                      entry.providerName &&
                        (entry.model ? `${entry.providerName} · ${entry.model}` : entry.providerName),
                      formatLongDate(entry.createdAt, i18n.language),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      closeSettings();
                      selectThread(`m:${entry.emailId}`);
                    }}
                  >
                    {t("labels.log.open")}
                  </Button>
                  {!entry.undone && (
                    <Button size="sm" icon={Undo2} busy={busy === entry.id} onClick={() => undo(entry)}>
                      {t("assist.labels.undo")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {log.length > limit && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setLimit(limit + 50)}>
          {t("labels.log.more")}
        </Button>
      )}
    </Section>
  );
}
