import clsx from "clsx";
import { Check, Pencil, Plus, Sparkles, Tags, Trash, Wand2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { AssistError, backend } from "@/backend/backend";
import type { AssistLabel, AssistLabelInput, AssistOptions } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, TextInput, Toggle } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import {
  chipStyle,
  LABEL_COLORS,
  LABEL_LIMITS,
  labelPatch,
  labelProblems,
  missingStarters,
  type StarterLabel,
} from "../labels";
import { assistErrorText, useAssistLabels, useAssistScope, useAssistSettings } from "../useAssist";
import { Note, Section } from "./common";

/** How many of the newest inbox mails "label now" looks at: what `AssistLabel/apply` takes at once. */
const APPLY_COUNT = 20;

/** The labels: whether they are set by themselves, the list, new ones, suggestions, and "label now". */
export function LabelSettings({ options }: { options: AssistOptions }) {
  const { t } = useT();
  const scope = useAssistScope();
  const { data: labels = [], isPending } = useAssistLabels();
  const { data: settings } = useAssistSettings();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [adding, setAdding] = useState(false);
  const [applying, setApplying] = useState(false);
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  useEffect(() => {
    setSettingsFormDirty(editing !== null);
    return () => setSettingsFormDirty(false);
  }, [editing, setSettingsFormDirty]);

  const starters = missingStarters(labels, (id: StarterLabel) => ({
    name: t(`assist.starter.${id}.name`),
    description: t(`assist.starter.${id}.description`),
  })).slice(0, Math.max(0, options.maxLabels - labels.length));
  const room = labels.length < options.maxLabels;
  const auto = options.features.autoLabels;

  const addStarters = async () => {
    setAdding(true);
    let made = 0;
    try {
      for (const input of starters) {
        await backend().createAssistLabel(scope, input);
        made += 1;
      }
      toast(t("assist.labels.startersAdded", { count: made }), "success");
    } catch (error) {
      toast(assistErrorText(error), "error");
    } finally {
      setAdding(false);
    }
  };

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

  return (
    <Section
      title={t("assist.labels.title")}
      description={auto ? t("assist.labels.description") : t("assist.labels.descriptionManual")}
      action={
        room &&
        editing !== "new" && (
          <Button size="sm" icon={Plus} onClick={() => setEditing("new")}>
            {t("assist.labels.new")}
          </Button>
        )
      }
    >
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

      {editing === "new" && <LabelEditor label={null} labels={labels} onDone={() => setEditing(null)} />}

      {starters.length > 0 && editing !== "new" && (
        <div className="flex flex-col gap-2 rounded-2xl bg-pink-tint/35 px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Wand2 className="size-4 text-pink" aria-hidden />
            {labels.length === 0 ? t("assist.labels.startersTitle") : t("assist.labels.startersMore")}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {starters.map((starter) => (
              <span
                key={starter.name}
                style={chipStyle(starter.color)}
                title={starter.description}
                className="inline-flex h-6 items-center rounded-full border px-2 text-[11.5px] font-semibold"
              >
                {starter.name}
              </span>
            ))}
          </div>
          <Button
            size="sm"
            variant="primary"
            icon={Plus}
            busy={adding}
            className="self-start"
            onClick={() => void addStarters()}
          >
            {t("assist.labels.addStarters", { count: starters.length })}
          </Button>
        </div>
      )}

      {!isPending && labels.length === 0 && starters.length === 0 && editing !== "new" && (
        <p className="text-[13px] text-muted">{t("assist.labels.empty")}</p>
      )}

      {labels.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {labels.map((label) =>
            editing === label.id ? (
              <li key={label.id}>
                <LabelEditor label={label} labels={labels} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <LabelRow key={label.id} label={label} onEdit={() => setEditing(label.id)} />
            ),
          )}
        </ul>
      )}
      {!room && <p className="text-[12.5px] text-muted">{t("assist.labels.full", { count: options.maxLabels })}</p>}

      {auto && labels.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-canvas px-3.5 py-2.5">
          <p className="min-w-[min(100%,14rem)] flex-1 text-[12.5px] text-muted">
            {t("assist.labels.applyDesc", { count: APPLY_COUNT })}
          </p>
          <Button size="sm" icon={Sparkles} busy={applying} onClick={() => void applyNow()}>
            {t("assist.labels.apply")}
          </Button>
        </div>
      )}
    </Section>
  );
}

function LabelRow({ label, onEdit }: { label: AssistLabel; onEdit: () => void }) {
  const { t } = useT();
  const scope = useAssistScope();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
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
          <p className="text-[12.5px] break-words text-muted">
            {label.description || <span className="italic">{t("assist.labels.noDescription")}</span>}
          </p>
        </div>
        <IconButton icon={Pencil} size="sm" label={t("assist.labels.edit", { name: label.name })} onClick={onEdit} />
        <IconButton
          icon={Trash}
          size="sm"
          label={t("assist.labels.delete", { name: label.name })}
          onClick={() => setConfirm(true)}
        />
      </div>
      {confirm && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-danger-tint px-3 py-2 text-[12.5px] text-danger">
          <span className="min-w-0 flex-1">{t("assist.labels.confirmDelete", { name: label.name })}</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="danger" icon={Trash} busy={busy} onClick={remove}>
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
  onDone,
}: {
  label: AssistLabel | null;
  labels: AssistLabel[];
  onDone: () => void;
}) {
  const { t } = useT();
  const scope = useAssistScope();
  const [form, setForm] = useState<AssistLabelInput>(() =>
    label
      ? { name: label.name, description: label.description, color: label.color }
      : { name: "", description: "", color: LABEL_COLORS[labels.length % LABEL_COLORS.length]! },
  );
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problems = labelProblems(form, labels, label?.id);
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
    if (Object.keys(problems).length > 0) return;
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
        <Tags className="size-4 text-pink" aria-hidden />
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
                <Check className={clsx("size-3.5", color ? "text-white" : "text-muted")} strokeWidth={3} aria-hidden />
              )}
            </button>
          ))}
        </div>
      </div>
      {failure && (
        <p role="alert" className="rounded-xl bg-danger-tint px-3 py-2 text-[13px] text-danger">
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
