import clsx from "clsx";
import { Button, Field, Icon, IconButton, ICONS, Select, Spinner, Switch, TextInput, Toggle } from "@uwusuite/design";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AssistError, backend } from "@/backend/backend";
import {
  LABEL_BASES,
  LABEL_DETECTORS,
  type AssistLabel,
  type AssistLabelInput,
  type AssistOptions,
  type LabelBase,
  type LabelConditionField,
  type LabelDetector,
  type LabelOverlap,
  type LabelRules,
} from "@/backend/types";
import { NyuThinking } from "@/components/nyu/NyuThinking";
import { useT } from "@/i18n";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { useLabelOverlap } from "../../labels/useLabels";
import {
  CONDITION_MAX_CHARS,
  conditionProblems,
  conditionText,
  LABEL_COLORS,
  LABEL_LIMITS,
  labelPatch,
  labelProblems,
  missingBases,
  overlapLines,
} from "../labels";
import { assistErrorText, useAssistLabels, useAssistScope, useAssistSettings } from "../useAssist";
import { Note, Section } from "./common";

/** How many of the newest inbox mails "label now" looks at: what `AssistLabel/apply` takes at once. */
const APPLY_COUNT = 20;

/**
 * The labels: whether they are set by themselves and "label now", the base labels first, then the
 * person's own ones and new ones.
 */
export function LabelSettings({ options }: { options: AssistOptions }) {
  const { t } = useT();
  const scope = useAssistScope();
  const { data: labels = [], isPending } = useAssistLabels();
  const { data: settings } = useAssistSettings();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [applying, setApplying] = useState(false);
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  useEffect(() => {
    setSettingsFormDirty(editing !== null);
    return () => setSettingsFormDirty(false);
  }, [editing, setSettingsFormDirty]);

  const bases = labels.filter((label) => label.base);
  const own = labels.filter((label) => !label.base);
  // Base labels don't count toward the limit.
  const room = own.length < options.maxLabels;
  const missing = missingBases(labels, LABEL_BASES, options.baseLabels);
  const auto = options.features.autoLabels;
  // What a new label starts with: an adopted base label's earlier description, or nothing.
  const [seed, setSeed] = useState("");
  const newEditor = useRef<HTMLDivElement>(null);
  const startNew = (description: string) => {
    setSeed(description);
    setEditing("new");
  };
  useEffect(() => {
    if (editing === "new" && seed) newEditor.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [editing, seed]);

  const applyNow = async () => {
    setApplying(true);
    try {
      const ids = await backend().recentInboxIds(scope, APPLY_COUNT);
      const labeled = await backend().applyAssistLabels(ids);
      const count = Object.values(labeled).filter((list) => list.length > 0).length;
      toast(count > 0 ? t("assist.labels.applied", { count }) : t("assist.labels.appliedNone"), "success");
    } catch (error) {
      toast(assistErrorText(error), "error");
    } finally {
      setApplying(false);
    }
  };

  const rows = (list: AssistLabel[]) => (
    <ul className="flex flex-col gap-1.5">
      {list.map((label) =>
        editing === label.id ? (
          <li key={label.id}>
            <LabelEditor
              label={label}
              labels={labels}
              maxConditions={options.maxLabelConditions}
              onDone={() => setEditing(null)}
            />
          </li>
        ) : (
          <LabelRow
            key={label.id}
            label={label}
            onEdit={() => setEditing(label.id)}
            onUsePrevious={
              room && label.previousDescription ? () => startNew(label.previousDescription ?? "") : undefined
            }
          />
        ),
      )}
    </ul>
  );

  return (
    <>
      <Section
        title={t("labels.settings.switchesTitle")}
        description={auto ? t("labels.settings.description") : t("labels.settings.descriptionManual")}
      >
        {settings && (
          <Toggle
            checked={settings.nonAiLabels}
            onChange={(nonAiLabels) =>
              void backend()
                .updateAssistSettings(scope, { nonAiLabels })
                .catch((error: unknown) => toast(assistErrorText(error), "error"))
            }
            label={t("labels.settings.nonAi")}
            description={t("labels.settings.nonAiDesc")}
          />
        )}
        {auto && settings && (
          <Toggle
            checked={settings.autoLabels}
            onChange={(autoLabels) =>
              void backend()
                .updateAssistSettings(scope, { autoLabels })
                .catch((error: unknown) => toast(assistErrorText(error), "error"))
            }
            label={t("assist.labels.auto")}
            description={labels.length === 0 ? t("assist.labels.autoNoLabels") : t("assist.labels.autoDesc")}
          />
        )}
        {auto && settings && !settings.effective.autoLabels && (
          <Note tone="warning">{t("assist.labels.noProvider")}</Note>
        )}
        {auto && labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-canvas px-3.5 py-2.5">
            <p className="min-w-[min(100%,14rem)] flex-1 text-[12.5px] text-muted">
              {t("assist.labels.applyDesc", { count: APPLY_COUNT })}
            </p>
            <Button
              size="sm"
              icon={ICONS.ai}
              busy={applying}
              busyIndicator={<NyuThinking size="sm" fallback={<Spinner />} />}
              onClick={() => void applyNow()}
            >
              {t("assist.labels.apply")}
            </Button>
          </div>
        )}
      </Section>

      {(bases.length > 0 || missing.length > 0) && (
        <Section title={t("labels.base.title")} description={t("labels.base.description")}>
          {bases.length > 0 && rows(bases)}
          {missing.length > 0 && <MissingBases missing={missing} />}
        </Section>
      )}

      <Section
        title={t("labels.settings.listTitle")}
        description={t("labels.settings.listDescription")}
        action={
          room &&
          editing !== "new" && (
            <Button size="sm" icon={ICONS.add} onClick={() => startNew("")}>
              {t("assist.labels.new")}
            </Button>
          )
        }
      >
        {editing === "new" && (
          <div ref={newEditor}>
            <LabelEditor
              key={seed}
              label={null}
              labels={labels}
              description={seed}
              maxConditions={options.maxLabelConditions}
              onDone={() => {
                setEditing(null);
                setSeed("");
              }}
            />
          </div>
        )}
        {!isPending && own.length === 0 && editing !== "new" && (
          <p className="text-[13px] text-muted">{t("assist.labels.empty")}</p>
        )}
        {own.length > 0 && rows(own)}
        {!room && <p className="text-[12.5px] text-muted">{t("assist.labels.full", { count: options.maxLabels })}</p>}
      </Section>
    </>
  );
}

/** Base labels the person deleted, each to be made again with its definition. */
function MissingBases({ missing }: { missing: LabelBase[] }) {
  const { t } = useT();
  const scope = useAssistScope();
  const [busy, setBusy] = useState<LabelBase | null>(null);
  const restore = (base: LabelBase) => {
    setBusy(base);
    backend()
      .restoreBaseLabel(scope, base)
      .then((label) => toast(t("labels.base.restored", { name: label.name }), "success"))
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => setBusy(null));
  };
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-canvas px-3.5 py-3">
      <div>
        <p className="text-[13px] font-semibold">{t("labels.base.missingTitle")}</p>
        <p className="text-[12.5px] text-muted">{t("labels.base.missingDescription")}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {missing.map((base) => (
          <Button
            key={base}
            size="sm"
            variant="ghost"
            icon={ICONS.reset}
            busy={busy === base}
            disabled={busy !== null && busy !== base}
            onClick={() => restore(base)}
          >
            {t("labels.base.restore", { name: t(`labels.base.names.${base}`) })}
          </Button>
        ))}
      </div>
    </div>
  );
}

function LabelRow({
  label,
  onEdit,
  onUsePrevious,
}: {
  label: AssistLabel;
  onEdit: () => void;
  /** Starts a new own label with the description the base label replaced; missing when there is no room. */
  onUsePrevious?: () => void;
}) {
  const { t } = useT();
  const scope = useAssistScope();
  const [forgetting, setForgetting] = useState(false);
  // The model gets the earlier description as a hint until it is forgotten (webmail WF-1).
  const forgetPrevious = () => {
    setForgetting(true);
    backend()
      .updateAssistLabel(scope, label.id, { previousDescription: null })
      .then(() => toast(t("labels.base.previousForgotten"), "success"))
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => setForgetting(false));
  };
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [definition, setDefinition] = useState(false);
  const [auto, setAuto] = useState<boolean | null>(null);
  const switchAuto = (on: boolean) => {
    setAuto(on);
    backend()
      .updateAssistLabel(scope, label.id, { auto: on })
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => setAuto(null));
  };
  // Shown as switched right away; the list catches up once the scope has it.
  const isAuto = auto ?? label.auto;
  const remove = () => {
    setBusy(true);
    backend()
      .deleteAssistLabel(scope, label.id)
      .then(() => toast(t("assist.labels.deleted", { name: label.name }), "success"))
      .catch((error: unknown) => toast(assistErrorText(error), "error"))
      .finally(() => {
        setBusy(false);
        setConfirm(false);
      });
  };
  return (
    <li className="flex flex-col gap-2 rounded-2xl border border-hairline bg-surface px-3.5 py-2.5">
      <div className="flex items-start gap-3">
        <span
          className={clsx("mt-1 size-3 shrink-0 rounded-full border", !label.color && "border-line bg-canvas")}
          style={label.color ? { backgroundColor: label.color, borderColor: label.color } : undefined}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13.5px] font-bold break-words">{label.name}</span>
            <code className="font-mono text-[11px] text-faint" title={t("assist.labels.keyword")}>
              {label.keyword}
            </code>
          </p>
          {label.base ? (
            <>
              <button
                type="button"
                aria-expanded={definition}
                onClick={() => setDefinition((open) => !open)}
                className="inline-flex items-center gap-1 rounded text-[12px] font-semibold text-muted hover:text-ink focus-visible:shadow-focus focus-visible:outline-none"
              >
                <Icon
                  icon={ICONS.expand}
                  size="xs"
                  className={clsx("transition-transform", definition && "rotate-180")}
                />
                {definition ? t("labels.base.hideDefinition") : t("labels.base.showDefinition")}
              </button>
              {definition && <p className="text-[12.5px] break-words text-muted">{label.description}</p>}
              {label.previousDescription && (
                <div className="mt-1.5 flex flex-col items-start gap-1 rounded-xl bg-canvas px-3 py-2 text-[12.5px]">
                  <p className="break-words">
                    <span className="font-semibold">{t("labels.base.previousDescription")}</span>{" "}
                    <span className="selectable italic">{label.previousDescription}</span>
                  </p>
                  <p className="text-[11.5px] text-muted">{t("labels.base.previousHint")}</p>
                  <div className="flex flex-wrap gap-1">
                    {onUsePrevious && (
                      <Button size="sm" variant="ghost" icon={ICONS.add} onClick={onUsePrevious}>
                        {t("labels.base.usePrevious")}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={ICONS.close} busy={forgetting} onClick={forgetPrevious}>
                      {t("labels.base.forgetPrevious")}
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <p className="text-[12.5px] break-words text-muted">
              {label.description || <span className="italic">{t("assist.labels.noDescription")}</span>}
            </p>
          )}
          <LabelAutomatic label={label} />
        </div>
        {label.base && (
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-[11.5px] text-muted sm:inline">
              {isAuto ? t("labels.base.autoOn") : t("labels.base.autoOff")}
            </span>
            <Switch
              size="sm"
              checked={isAuto}
              label={t("labels.base.auto", { name: label.name })}
              disabled={auto !== null}
              onChange={switchAuto}
            />
          </div>
        )}
        <IconButton
          icon={ICONS.edit}
          size="sm"
          label={t("assist.labels.edit", { name: label.name })}
          onClick={onEdit}
        />
        <IconButton
          icon={ICONS.delete}
          size="sm"
          label={t("assist.labels.delete", { name: label.name })}
          onClick={() => setConfirm(true)}
        />
      </div>
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-danger-tint px-3 py-2 text-[12.5px] text-danger-ink">
          <span className="min-w-0 flex-1">{t("assist.labels.confirmDelete", { name: label.name })}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="danger" icon={ICONS.delete} busy={busy} onClick={remove}>
            {t("assist.labels.deleteShort")}
          </Button>
        </div>
      )}
    </li>
  );
}

function LabelEditor({
  label,
  labels,
  description = "",
  maxConditions,
  onDone,
}: {
  label: AssistLabel | null;
  labels: AssistLabel[];
  /** What a new label's description starts with. */
  description?: string;
  maxConditions: number;
  onDone: () => void;
}) {
  const { t } = useT();
  const scope = useAssistScope();
  const [form, setForm] = useState<AssistLabelInput>(() =>
    label
      ? {
          name: label.name,
          description: label.description,
          color: label.color,
          rules: label.rules,
          detector: label.detector,
          learnSenders: label.learnSenders,
          classifier: label.classifier,
          auto: label.auto,
        }
      : {
          name: "",
          description,
          color: LABEL_COLORS[labels.length % LABEL_COLORS.length]!,
          rules: null,
          detector: null,
          learnSenders: true,
          classifier: true,
          auto: true,
        },
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problems = labelProblems(form, labels, label?.id);
  const base = label?.base ?? null;
  // Only own labels are checked: a base label's definition is fixed.
  const overlaps = useLabelOverlap(scope, form.name, form.description, label?.id, !base && !problems.name);
  const problemText = (field: "name" | "description") => {
    const problem = touched ? problems[field] : undefined;
    return problem ? t(`assist.labels.problem.${problem}`, { max: LABEL_LIMITS[field] }) : undefined;
  };
  const change = (patch: Partial<AssistLabelInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    setFailure(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (Object.keys(problems).length > 0 || conditionProblems(form.rules ?? null).some(Boolean)) return;
    setBusy(true);
    const work = label
      ? backend().updateAssistLabel(scope, label.id, labelPatch(label, form))
      : backend().createAssistLabel(scope, form);
    Promise.resolve(work)
      .then(() => {
        toast(label ? t("assist.labels.saved") : t("assist.labels.created", { name: form.name.trim() }), "success");
        onDone();
      })
      .catch((error: unknown) =>
        setFailure(
          error instanceof AssistError && error.type === "invalidProperties" && error.description
            ? error.description
            : assistErrorText(error),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-3 rounded-2xl border border-pink/30 bg-pink-tint/20 px-4 py-3.5"
    >
      <p className="flex items-center gap-1.5 text-[13.5px] font-bold">
        <Icon icon={ICONS.labels} className="text-pink" />
        {label ? t("assist.labels.editTitle", { name: label.name }) : t("assist.labels.newTitle")}
      </p>
      <Field label={t("assist.labels.name")} error={problemText("name")}>
        {(id) => (
          <TextInput
            id={id}
            value={form.name}
            placeholder={t("assist.labels.namePlaceholder")}
            onChange={(event) => change({ name: event.target.value })}
          />
        )}
      </Field>
      {base ? (
        <div className="flex flex-col gap-1">
          <p className="text-[13px] font-semibold text-muted">{t("assist.labels.descriptionField")}</p>
          <p className="rounded-control border border-hairline bg-canvas px-3.5 py-2.5 text-[13px] break-words">
            {form.description}
          </p>
          <p className="text-[12.5px] text-muted">{t("labels.base.fixedDefinition")}</p>
        </div>
      ) : (
        <Field
          label={t("assist.labels.descriptionField")}
          hint={t("assist.labels.descriptionHint")}
          error={problemText("description")}
        >
          {(id) => (
            <textarea
              id={id}
              rows={2}
              value={form.description}
              placeholder={t("assist.labels.descriptionPlaceholder")}
              onChange={(event) => change({ description: event.target.value })}
              className="w-full resize-y rounded-control border border-line bg-surface px-3.5 py-2.5 text-sm placeholder:text-faint focus:border-pink focus:shadow-focus focus:outline-none"
            />
          )}
        </Field>
      )}
      <OverlapWarning overlaps={overlaps} />
      <div className="flex flex-col gap-1.5">
        <p className="text-[13px] font-semibold text-muted">{t("assist.labels.color")}</p>
        <div role="radiogroup" aria-label={t("assist.labels.color")} className="flex flex-wrap gap-1.5">
          {[null, ...LABEL_COLORS].map((color) => (
            <button
              key={color ?? "none"}
              type="button"
              role="radio"
              aria-checked={form.color === color}
              aria-label={color ?? t("assist.labels.noColor")}
              title={color ?? t("assist.labels.noColor")}
              onClick={() => change({ color })}
              className={clsx(
                "grid size-7 place-items-center rounded-full border-2 transition-transform focus-visible:shadow-focus focus-visible:outline-none",
                form.color === color ? "scale-110 border-ink" : "border-transparent",
                !color && "bg-canvas",
              )}
              style={color ? { backgroundColor: color } : undefined}
            >
              {form.color === color && (
                <Icon icon={ICONS.done} size="xs" className={clsx(color ? "text-white" : "text-muted")} />
              )}
            </button>
          ))}
        </div>
      </div>
      <AutomaticEditor
        form={form}
        change={change}
        touched={touched}
        maxConditions={maxConditions}
        examples={label?.examples ?? 0}
        base={base}
      />
      {failure && (
        <p role="alert" className="rounded-xl bg-danger-tint px-3 py-2 text-[13px] text-danger-ink">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {label ? t("common.save") : t("assist.labels.create")}
        </Button>
      </div>
    </form>
  );
}

/** Labels a new or changed one overlaps with: a warning only, saving stays possible. */
export function OverlapWarning({ overlaps }: { overlaps: LabelOverlap[] }) {
  const { t } = useT();
  const lines = overlapLines(overlaps, t);
  if (lines.length === 0) return null;
  return (
    <div role="status" className="flex gap-2 rounded-xl bg-warning-tint px-3 py-2 text-[12.5px] text-warning-ink">
      <Icon icon={ICONS.warning} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{t("labels.overlap.title")}</p>
        <ul className="list-disc pl-4">
          {lines.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
        <p className="text-muted">{t("labels.overlap.hint")}</p>
      </div>
    </div>
  );
}

/** What puts a label on new mail by itself, in one line under its description. */
function LabelAutomatic({ label }: { label: AssistLabel }) {
  const { t } = useT();
  const count =
    label.totalEmails !== null
      ? t("labels.settings.count", { count: label.totalEmails, unread: label.unreadEmails ?? 0 })
      : null;
  // A base label shows its own switch; an own one says it here.
  if (!label.auto && !label.base) {
    return (
      <p className="mt-0.5 text-[11.5px] break-words text-faint">
        {[count, t("labels.base.autoOff")].filter(Boolean).join(" · ")}
      </p>
    );
  }
  const parts = [
    label.detector && t(`labels.detector.${label.detector}`),
    label.rules &&
      label.rules.conditions
        .map((condition) => conditionText(condition, t))
        .join(label.rules.match === "any" ? t("labels.reason.or") : t("labels.reason.and")),
    label.learnSenders && t("labels.settings.learnsSenders"),
    label.classifier &&
      (label.examples >= CLASSIFIER_MIN
        ? t("labels.settings.classifierOn", { count: label.examples })
        : t("labels.settings.classifierLearning", { count: label.examples, needed: CLASSIFIER_MIN })),
  ].filter(Boolean);
  if (parts.length === 0 && !count) return null;
  return <p className="mt-0.5 text-[11.5px] break-words text-faint">{[count, ...parts].filter(Boolean).join(" · ")}</p>;
}

/** Examples the classifier needs before it puts a label on (docs/labels.md of UwUMail Server). */
const CLASSIFIER_MIN = 15;

const FIELDS: LabelConditionField[] = ["from", "subject", "text", "hasAttachment"];

/** The part of the label form that puts it on new mail by itself: detector, rules, learning. */
function AutomaticEditor({
  form,
  change,
  touched,
  maxConditions,
  examples,
  base,
}: {
  form: AssistLabelInput;
  change: (patch: Partial<AssistLabelInput>) => void;
  touched: boolean;
  maxConditions: number;
  examples: number;
  base: LabelBase | null;
}) {
  const { t } = useT();
  const rules: LabelRules = form.rules ?? { match: "all", conditions: [] };
  const problems = conditionProblems(rules);
  const setRules = (next: LabelRules) => change({ rules: next });
  const setCondition = (index: number, patch: Partial<LabelRules["conditions"][number]>) =>
    setRules({
      ...rules,
      conditions: rules.conditions.map((condition, at) => (at === index ? { ...condition, ...patch } : condition)),
    });

  return (
    <fieldset className="flex flex-col gap-3 rounded-2xl bg-surface/70 px-3.5 py-3">
      <legend className="sr-only">{t("labels.settings.automaticTitle")}</legend>
      <div>
        <p className="text-[13px] font-bold">{t("labels.settings.automaticTitle")}</p>
        <p className="text-[12.5px] text-muted">{t("labels.settings.automaticDesc")}</p>
      </div>
      <Toggle
        checked={form.auto ?? true}
        onChange={(auto) => change({ auto })}
        label={t("labels.settings.autoLabel")}
        description={t("labels.settings.autoLabelDesc")}
      />
      {base ? (
        <p className="text-[12.5px] text-muted">{t("labels.base.detectorBuiltIn")}</p>
      ) : (
        <Field label={t("labels.settings.detector")} hint={t("labels.settings.detectorHint")}>
          {(id) => (
            <Select
              id={id}
              value={form.detector ?? ""}
              onChange={(event) => change({ detector: (event.target.value || null) as LabelDetector | null })}
            >
              <option value="">{t("labels.settings.detectorNone")}</option>
              {LABEL_DETECTORS.map((detector) => (
                <option key={detector} value={detector}>
                  {t(`labels.detector.${detector}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-muted">
          <span>{t("labels.settings.rules")}</span>
          {rules.conditions.length > 1 && (
            <Select
              aria-label={t("labels.settings.match")}
              value={rules.match}
              onChange={(event) => setRules({ ...rules, match: event.target.value === "any" ? "any" : "all" })}
              className="w-auto"
            >
              <option value="all">{t("labels.settings.matchAll")}</option>
              <option value="any">{t("labels.settings.matchAny")}</option>
            </Select>
          )}
        </div>
        {rules.conditions.length === 0 && <p className="text-[12.5px] text-muted">{t("labels.settings.noRules")}</p>}
        <ul className="flex flex-col gap-2">
          {rules.conditions.map((condition, index) => {
            const problem = touched ? problems[index] : null;
            return (
              <li key={index} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label={t("labels.settings.field")}
                    value={condition.field}
                    onChange={(event) => {
                      const field = event.target.value as LabelConditionField;
                      setCondition(index, {
                        field,
                        value:
                          field === "hasAttachment"
                            ? "true"
                            : condition.field === "hasAttachment"
                              ? ""
                              : condition.value,
                      });
                    }}
                    className="w-[min(100%,12rem)]"
                  >
                    {FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {t(`labels.settings.fields.${field}`)}
                      </option>
                    ))}
                  </Select>
                  {condition.field === "hasAttachment" ? (
                    <Select
                      aria-label={t("labels.settings.value")}
                      value={condition.value === "false" ? "false" : "true"}
                      onChange={(event) => setCondition(index, { value: event.target.value })}
                      className="min-w-0 flex-1"
                    >
                      <option value="true">{t("labels.settings.withAttachment")}</option>
                      <option value="false">{t("labels.settings.withoutAttachment")}</option>
                    </Select>
                  ) : (
                    <TextInput
                      aria-label={t("labels.settings.value")}
                      value={condition.value}
                      maxLength={CONDITION_MAX_CHARS + 20}
                      placeholder={t(`labels.settings.placeholders.${condition.field}`)}
                      onChange={(event) => setCondition(index, { value: event.target.value })}
                      className="min-w-[10rem] flex-1"
                    />
                  )}
                  <IconButton
                    icon={ICONS.close}
                    size="sm"
                    label={t("labels.settings.removeCondition")}
                    onClick={() => setRules({ ...rules, conditions: rules.conditions.filter((_, at) => at !== index) })}
                  />
                </div>
                {problem && (
                  <p role="alert" className="text-[12.5px] text-danger-ink">
                    {t(`labels.settings.problem.${problem}`, { max: CONDITION_MAX_CHARS })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {rules.conditions.length < maxConditions && (
          <Button
            size="sm"
            variant="ghost"
            icon={ICONS.add}
            className="self-start"
            onClick={() => setRules({ ...rules, conditions: [...rules.conditions, { field: "from", value: "" }] })}
          >
            {t("labels.settings.addCondition")}
          </Button>
        )}
      </div>

      <Toggle
        checked={form.learnSenders ?? true}
        onChange={(learnSenders) => change({ learnSenders })}
        label={t("labels.settings.learnSenders")}
        description={t("labels.settings.learnSendersDesc")}
      />
      <Toggle
        checked={form.classifier ?? true}
        onChange={(classifier) => change({ classifier })}
        label={t("labels.settings.classifier")}
        description={t("labels.settings.classifierDesc", { count: examples, needed: CLASSIFIER_MIN })}
      />
    </fieldset>
  );
}
