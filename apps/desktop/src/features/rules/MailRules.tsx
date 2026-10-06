import clsx from "clsx";
import { Button, Icon, IconButton, ICONS, Select, Switch } from "@uwusuite/design";
import { useEffect, useState, type ReactNode } from "react";
import { backend } from "@/backend/backend";
import { ArmedButton } from "@/components/ui/ArmedButton";
import { useT } from "@/i18n";
import { emptyRuleSet, newRule, type MailRule, type RuleSet } from "@/lib/sieveRules";
import { useFolders } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { useAccountLabels } from "../labels/useLabels";
import { folderDisplayPath } from "./folderPath";
import { RuleEditor } from "./RuleEditor";
import { useMailRules, useMailRulesAccounts } from "./useMailRules";

/**
 * Settings → Rules: what the server does with arriving mail. The rules are one Sieve script on
 * the server (see lib/sieveRules), so they work while no app is open, and the app sees them too.
 */
export function MailRules() {
  const { t } = useT();
  const { data: accounts = [] } = useMailRulesAccounts();
  const [chosen, setChosen] = useState<string | null>(null);
  const accountId = chosen ?? accounts[0]?.id;
  if (!accountId) return null;
  return (
    <div className="flex flex-col gap-4 py-4">
      <div>
        <p className="text-sm font-semibold">{t("rules.title")}</p>
        <p className="text-[13px] text-muted">{t("rules.description")}</p>
      </div>
      {accounts.length > 1 && (
        <Select
          aria-label={t("rules.account")}
          value={accountId}
          onChange={(event) => setChosen(event.target.value)}
          className="max-w-[320px]"
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.email}
            </option>
          ))}
        </Select>
      )}
      <AccountRules key={accountId} accountId={accountId} />
    </div>
  );
}

function AccountRules({ accountId }: { accountId: string }) {
  const { t } = useT();
  const { query, saving, save, saveText } = useMailRules(accountId);
  const [editing, setEditing] = useState<{ rule: MailRule; index: number | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  // The settings window shouldn't vanish while a rule is half written.
  useEffect(() => {
    setSettingsFormDirty(editing !== null && dirty);
    return () => setSettingsFormDirty(false);
  }, [editing, dirty, setSettingsFormDirty]);

  if (query.isPending) return <p className="text-[13px] text-muted">{t("rules.loading")}</p>;
  if (query.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[13px] text-danger-ink">
          {t("rules.loadFailed", { reason: query.error instanceof Error ? query.error.message : "" })}
        </p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const { parsed, active, exists, otherActive } = query.data;
  if (parsed.kind === "foreign") {
    return (
      <div className="flex flex-col gap-3">
        {otherActive !== null && <OtherScriptNote name={otherActive} />}
        <ForeignScript accountId={accountId} text={parsed.text} busy={saving} onSaveText={saveText} onReplace={save} />
      </div>
    );
  }
  const set = parsed.set;
  // Another app's script filters the mail. Saving would switch it off, so nothing is saved until the
  // person chose these rules over it (security-audit C-11, webmail W-25).
  const locked = otherActive !== null;

  if (editing) {
    const close = () => {
      setEditing(null);
      setDirty(false);
    };
    return (
      <RuleEditor
        key={editing.rule.id}
        accountId={accountId}
        rule={editing.rule}
        isNew={editing.index === null}
        busy={saving}
        onDirty={setDirty}
        onCancel={close}
        onSave={async (rule) => {
          const rules =
            editing.index === null ? [...set.rules, rule] : set.rules.map((r, i) => (i === editing.index ? rule : r));
          if (await save({ v: 1, rules })) {
            toast(t("rules.saved"), "success");
            close();
          }
        }}
      />
    );
  }

  const change = (rules: MailRule[]) => void save({ v: 1, rules });
  const remove = async (index: number) => {
    const before: RuleSet = set;
    const gone = set.rules[index]!;
    if (await save({ v: 1, rules: set.rules.filter((_, i) => i !== index) })) {
      toast(t("rules.deleted", { name: gone.name }), "success", undefined, {
        action: { label: t("toast.undo"), run: () => void save(before) },
      });
    }
  };
  const move = (index: number, step: -1 | 1) => {
    const rules = [...set.rules];
    const [rule] = rules.splice(index, 1);
    rules.splice(index + step, 0, rule!);
    change(rules);
  };

  return (
    <div className="flex flex-col gap-3">
      {locked ? (
        <OtherScriptNote name={otherActive}>
          <Button size="sm" busy={saving} onClick={() => void save(set)}>
            {t("rules.takeOver")}
          </Button>
        </OtherScriptNote>
      ) : (
        exists &&
        !active && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-warning-tint px-4 py-3 text-[13px]">
            <Icon icon={ICONS.warning} className="shrink-0 text-warning-ink" />
            <span className="min-w-0 flex-1">{t("rules.inactive")}</span>
            <Button size="sm" busy={saving} onClick={() => void save(set)}>
              {t("rules.activate")}
            </Button>
          </div>
        )
      )}
      {set.rules.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
          {t("rules.empty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-1 rounded-2xl border border-hairline p-1" aria-label={t("rules.title")}>
          {set.rules.map((rule, index) => (
            <li key={rule.id} className={clsx("flex items-center gap-2 rounded-xl py-1.5 pr-1 pl-3 hover:bg-elevated")}>
              {/* The package's Switch names itself for screen readers only; the title is for the mouse. */}
              <span className="flex" title={t("rules.enabled", { name: rule.name })}>
                <Switch
                  size="sm"
                  checked={rule.enabled}
                  disabled={saving || locked}
                  label={t("rules.enabled", { name: rule.name })}
                  onChange={(enabled) => change(set.rules.map((r, i) => (i === index ? { ...r, enabled } : r)))}
                />
              </span>
              <button
                type="button"
                disabled={locked}
                onClick={() => setEditing({ rule, index })}
                className={clsx("min-w-0 flex-1 py-1 text-left", !rule.enabled && "opacity-60")}
              >
                <span className="block truncate text-[13.5px] font-semibold">{rule.name}</span>
                <RuleSummary accountId={accountId} rule={rule} />
              </button>
              <IconButton
                icon={ICONS.moveUp}
                size="sm"
                label={t("rules.moveUp", { name: rule.name })}
                disabled={saving || locked || index === 0}
                onClick={() => move(index, -1)}
              />
              <IconButton
                icon={ICONS.moveDown}
                size="sm"
                label={t("rules.moveDown", { name: rule.name })}
                disabled={saving || locked || index === set.rules.length - 1}
                onClick={() => move(index, 1)}
              />
              <IconButton
                icon={ICONS.edit}
                size="sm"
                label={t("rules.editRule", { name: rule.name })}
                disabled={locked}
                onClick={() => setEditing({ rule, index })}
              />
              <IconButton
                icon={ICONS.delete}
                size="sm"
                label={t("rules.deleteRule", { name: rule.name })}
                disabled={saving || locked}
                onClick={() => void remove(index)}
              />
            </li>
          ))}
        </ol>
      )}
      <Button
        icon={ICONS.add}
        className="self-start"
        disabled={locked}
        onClick={() => setEditing({ rule: newRule(), index: null })}
      >
        {t("rules.newRule")}
      </Button>
    </div>
  );
}

/** Another script filters the mail on the server: which one, and that saving here switches it off. */
function OtherScriptNote({ name, children }: { name: string; children?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-warning-tint px-4 py-3 text-[13px]">
      <Icon icon={ICONS.warning} className="shrink-0 text-warning-ink" />
      <span className="min-w-0 flex-1">
        {name.trim() ? t("rules.otherActive", { name: name.trim() }) : t("rules.otherActiveUnnamed")}
      </span>
      {children}
    </div>
  );
}

/** "From contains … → Move to Receipts", in plain text. */
function RuleSummary({ accountId, rule }: { accountId: string; rule: MailRule }) {
  const { t } = useT();
  const { data: folders = [] } = useFolders();
  const { data: labels = [] } = useAccountLabels(accountId);
  const labelName = (keyword: string, fallback = keyword) =>
    labels.find((label) => label.keyword === keyword)?.name ?? fallback;
  const conditions =
    rule.conditions.length === 0
      ? t("rules.everyMessage")
      : rule.conditions
          .map((c) =>
            c.field === "label"
              ? t(`rules.summary.label.${c.op === "isNot" ? "isNot" : "is"}`, { name: labelName(c.value) })
              : `${t(`rules.field.${c.field}`)} ${t(`rules.op.${c.op}`)} „${c.value}“`,
          )
          .join(rule.match === "any" ? ` ${t("rules.or")} ` : ` ${t("rules.and")} `);
  const actions = rule.actions
    .map((action) => {
      if (action.type === "move") {
        const folder = folders.find((f) => f.id === action.mailboxId);
        const name = folder
          ? folderDisplayPath(folder, folders, (f) => (f.role ? t(`folder.${f.role}`) : f.name))
          : action.mailboxName;
        return t("rules.summary.move", { folder: name });
      }
      if (action.type === "forward") return t("rules.summary.forward", { address: action.address });
      if (action.type === "label") return t("rules.summary.setLabel", { name: labelName(action.keyword, action.name) });
      return t(`rules.action.${action.type}`);
    })
    .join(", ");
  return (
    <span className="block truncate text-[12.5px] text-muted">
      {conditions} → {actions}
      {rule.stop ? ` · ${t("rules.summary.stop")}` : ""}
    </span>
  );
}

/** A script somebody wrote or changed outside UwUMail: shown as text, checked by the server before it's saved. */
function ForeignScript({
  accountId,
  text,
  busy,
  onSaveText,
  onReplace,
}: {
  accountId: string;
  text: string;
  busy: boolean;
  onSaveText: (text: string) => Promise<boolean>;
  onReplace: (set: RuleSet) => Promise<boolean>;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState(text);
  const [replacing, setReplacing] = useState(false);
  const [checking, setChecking] = useState(false);
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  useEffect(() => {
    setSettingsFormDirty(draft !== text);
    return () => setSettingsFormDirty(false);
  }, [draft, text, setSettingsFormDirty]);

  const check = async () => {
    setChecking(true);
    try {
      const problem = await backend().validateMailRules(draft, accountId);
      toast(problem ? t("rules.invalid", { reason: problem }) : t("rules.valid"), problem ? "error" : "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 rounded-2xl bg-warning-tint px-4 py-3 text-[13px]">
        <Icon icon={ICONS.warning} className="mt-0.5 shrink-0 text-warning-ink" />
        <div>
          <p className="font-semibold">{t("rules.foreignTitle")}</p>
          <p className="text-muted">{t("rules.foreignBody")}</p>
        </div>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={t("rules.scriptLabel")}
        rows={14}
        className="w-full resize-y rounded-control border border-line bg-surface px-3.5 py-3 font-mono text-[12.5px] leading-relaxed text-ink focus:border-pink focus:shadow-focus focus:outline-none"
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={busy} disabled={draft === text} onClick={() => void onSaveText(draft)}>
          {t("rules.saveScript")}
        </Button>
        <Button busy={checking} onClick={() => void check()}>
          {t("rules.check")}
        </Button>
        <span className="flex-1" />
        {replacing ? (
          <>
            {/* Takes the place of "Replace" under a held key: it only answers once that is over. */}
            <ArmedButton
              variant="danger"
              busy={busy}
              onClick={() => void onReplace(emptyRuleSet()).then(() => setReplacing(false))}
            >
              {t("rules.replaceConfirm")}
            </ArmedButton>
            <Button variant="ghost" onClick={() => setReplacing(false)}>
              {t("common.cancel")}
            </Button>
          </>
        ) : (
          <Button variant="danger" onClick={() => setReplacing(true)}>
            {t("rules.replace")}
          </Button>
        )}
      </div>
      {replacing && <p className="text-[13px] text-muted">{t("rules.replaceBody")}</p>}
    </div>
  );
}
