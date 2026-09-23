import clsx from "clsx";
import { FolderInput, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Segmented, Select, TextInput, Toggle } from "@/components/ui/Field";
import { Menu } from "@/components/ui/Menu";
import { useT } from "@/i18n";
import { useFolders } from "@/lib/queries";
import {
  RULE_FIELDS,
  RULE_OPS,
  validateRule,
  type MailRule,
  type RuleAction,
  type RuleCondition,
  type RuleProblem,
} from "@/lib/sieveRules";
import { FolderPicker } from "./FolderPicker";
import { folderDisplayPath } from "./folderPath";

interface RuleEditorProps {
  accountId: string;
  rule: MailRule;
  isNew: boolean;
  busy: boolean;
  onSave: (rule: MailRule) => void;
  onCancel: () => void;
  /** Tells whether there is unsaved input. */
  onDirty?: (dirty: boolean) => void;
}

type ActionType = RuleAction["type"];
const ACTION_TYPES: ActionType[] = ["move", "trash", "markRead", "flag", "forward"];

/** Name, conditions and actions of one rule. Problems show once saving was tried. */
export function RuleEditor({ accountId, rule, isNew, busy, onSave, onCancel, onDirty }: RuleEditorProps) {
  const { t } = useT();
  const { data: folders = [] } = useFolders();
  const [draft, setDraftState] = useState(rule);
  const [tried, setTried] = useState(false);
  const [picking, setPicking] = useState<number | null>(null);
  const problems = validateRule(draft);
  const shown = tried ? problems : [];
  const has = (match: (problem: RuleProblem) => boolean) => shown.some(match);

  const setDraft = (next: MailRule) => {
    setDraftState(next);
    onDirty?.(true);
  };
  const setCondition = (index: number, patch: Partial<RuleCondition>) =>
    setDraft({
      ...draft,
      conditions: draft.conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    });
  const setAction = (index: number, action: RuleAction) =>
    setDraft({ ...draft, actions: draft.actions.map((other, i) => (i === index ? action : other)) });
  const removeAction = (index: number) => setDraft({ ...draft, actions: draft.actions.filter((_, i) => i !== index) });

  const trash = folders.find((folder) => folder.accountId === accountId && folder.role === "trash");
  const present = new Set(draft.actions.map((action) => action.type));
  const filing = present.has("move") || present.has("trash");
  const addable = ACTION_TYPES.filter((type) => (type === "move" || type === "trash" ? !filing : !present.has(type)));
  const newAction = (type: ActionType): RuleAction => {
    switch (type) {
      case "move":
        return { type: "move", mailboxId: "", mailboxName: "" };
      case "trash":
        return { type: "trash", mailboxId: trash?.id ?? "", mailboxName: trash?.path ?? "" };
      case "forward":
        return { type: "forward", address: "", keepCopy: true };
      default:
        return { type };
    }
  };

  const save = () => {
    setTried(true);
    if (problems.length === 0) onSave({ ...draft, name: draft.name.trim() });
  };

  return (
    <form
      className="flex flex-col gap-5"
      aria-label={isNew ? t("rules.newRule") : t("rules.editRule", { name: rule.name })}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <Field label={t("rules.name")} error={has((p) => p.kind === "noName") ? t("rules.problem.noName") : undefined}>
        {(id) => (
          <TextInput
            id={id}
            autoFocus
            value={draft.name}
            maxLength={120}
            placeholder={t("rules.namePlaceholder")}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        )}
      </Field>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2 text-sm font-semibold">{t("rules.when")}</legend>
        {draft.conditions.length > 1 && (
          <Segmented
            label={t("rules.when")}
            value={draft.match}
            onChange={(match) => setDraft({ ...draft, match })}
            options={[
              { value: "all", label: t("rules.matchAll") },
              { value: "any", label: t("rules.matchAny") },
            ]}
          />
        )}
        {draft.conditions.length === 0 && <p className="text-[13px] text-muted">{t("rules.everyMessage")}</p>}
        {draft.conditions.map((condition, index) => {
          const empty = has((p) => p.kind === "emptyValue" && p.condition === index);
          return (
            <div key={index} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <Select
                  aria-label={t("rules.field.label")}
                  value={condition.field}
                  onChange={(event) => setCondition(index, { field: event.target.value as RuleCondition["field"] })}
                  className="w-full sm:w-40 sm:shrink-0"
                >
                  {RULE_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {t(`rules.field.${field}`)}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label={t("rules.op.label")}
                  value={condition.op}
                  onChange={(event) => setCondition(index, { op: event.target.value as RuleCondition["op"] })}
                  className="w-full sm:w-44 sm:shrink-0"
                >
                  {RULE_OPS.map((op) => (
                    <option key={op} value={op}>
                      {t(`rules.op.${op}`)}
                    </option>
                  ))}
                </Select>
                <TextInput
                  aria-label={t("rules.value")}
                  aria-invalid={empty}
                  value={condition.value}
                  onChange={(event) => setCondition(index, { value: event.target.value })}
                  className="min-w-0 flex-1"
                />
                <IconButton
                  icon={X}
                  size="sm"
                  label={t("rules.removeCondition")}
                  onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}
                />
              </div>
              {empty && (
                <p role="alert" className="text-[13px] text-danger">
                  {t("rules.problem.emptyValue")}
                </p>
              )}
            </div>
          );
        })}
        <Button
          size="sm"
          variant="ghost"
          icon={Plus}
          className="self-start"
          onClick={() =>
            setDraft({ ...draft, conditions: [...draft.conditions, { field: "subject", op: "contains", value: "" }] })
          }
        >
          {t("rules.addCondition")}
        </Button>
      </fieldset>

      <fieldset className="flex flex-col gap-2.5">
        <legend className="mb-2 text-sm font-semibold">{t("rules.then")}</legend>
        {draft.actions.map((action, index) => (
          <ActionRow
            key={`${action.type}-${index}`}
            action={action}
            problem={shown.find((p) => (p.kind === "noFolder" || p.kind === "badAddress") && p.action === index)}
            onChange={(next) => setAction(index, next)}
            onRemove={() => removeAction(index)}
            onPickFolder={() => setPicking(index)}
          />
        ))}
        {has((p) => p.kind === "noActions") && (
          <p role="alert" className="text-[13px] text-danger">
            {t("rules.problem.noActions")}
          </p>
        )}
        {has((p) => p.kind === "tooManyForwards" || p.kind === "tooManyFolders") && (
          <p role="alert" className="text-[13px] text-danger">
            {t("rules.problem.tooMany")}
          </p>
        )}
        {addable.length > 0 && (
          <Menu
            className="self-start"
            items={addable.map((type) => ({
              label: t(`rules.action.${type}`),
              onSelect: () => {
                setDraft({ ...draft, actions: [...draft.actions, newAction(type)] });
                if (type === "move") setPicking(draft.actions.length);
              },
            }))}
            trigger={(menu) => (
              <Button
                size="sm"
                variant="ghost"
                icon={Plus}
                onClick={menu.toggle}
                aria-haspopup={menu["aria-haspopup"]}
                aria-expanded={menu["aria-expanded"]}
                aria-controls={menu["aria-controls"]}
              >
                {t("rules.addAction")}
              </Button>
            )}
          />
        )}
      </fieldset>

      <Toggle
        checked={draft.stop}
        onChange={(stop) => setDraft({ ...draft, stop })}
        label={t("rules.stop")}
        description={t("rules.stopDesc")}
      />

      <div className="flex justify-end gap-2 border-t border-hairline pt-4">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" busy={busy}>
          {t("common.save")}
        </Button>
      </div>

      <FolderPicker
        open={picking !== null}
        accountId={accountId}
        onClose={() => setPicking(null)}
        onPick={(folder) => {
          if (picking !== null) setAction(picking, { type: "move", mailboxId: folder.id, mailboxName: folder.path });
          setPicking(null);
        }}
      />
    </form>
  );
}

function ActionRow({
  action,
  problem,
  onChange,
  onRemove,
  onPickFolder,
}: {
  action: RuleAction;
  problem: RuleProblem | undefined;
  onChange: (action: RuleAction) => void;
  onRemove: () => void;
  onPickFolder: () => void;
}) {
  const { t } = useT();
  const { data: folders = [] } = useFolders();
  const folderLabel = (id: string, fallback: string) => {
    const folder = folders.find((f) => f.id === id);
    if (!folder) return fallback;
    return folderDisplayPath(folder, folders, (f) => (f.role ? t(`folder.${f.role}`) : f.name));
  };

  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-hairline px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13.5px] font-semibold">{t(`rules.action.${action.type}`)}</span>
        {action.type === "move" && (
          <Button size="sm" icon={FolderInput} onClick={onPickFolder} className="max-w-full min-w-0">
            <span className="truncate">
              {action.mailboxId ? folderLabel(action.mailboxId, action.mailboxName) : t("rules.chooseFolder")}
            </span>
          </Button>
        )}
        <span className="flex-1" />
        <IconButton icon={X} size="sm" label={t("rules.removeAction")} onClick={onRemove} />
      </div>
      {action.type === "forward" && (
        <div className="flex flex-col gap-2">
          <TextInput
            type="email"
            inputMode="email"
            autoComplete="off"
            aria-label={t("rules.forwardTo")}
            aria-invalid={problem?.kind === "badAddress"}
            placeholder={t("rules.forwardPlaceholder")}
            value={action.address}
            onChange={(event) => onChange({ ...action, address: event.target.value })}
          />
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={action.keepCopy}
              onChange={(event) => onChange({ ...action, keepCopy: event.target.checked })}
              className="size-4 accent-pink"
            />
            {t("rules.keepCopy")}
          </label>
          <p className="text-[12px] text-muted">{t("rules.forwardHint")}</p>
        </div>
      )}
      {problem && (
        <p role="alert" className={clsx("text-[13px] text-danger")}>
          {problem.kind === "badAddress" ? t("rules.problem.badAddress") : t("rules.problem.noFolder")}
        </p>
      )}
    </div>
  );
}
