import clsx from "clsx";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import type { Account } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { AccountDot } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ConfirmDiscardDialog } from "@/components/ui/ConfirmDiscardDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Field, Segmented, TextInput, Toggle } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { useAccounts } from "@/lib/queries";
import { WORKSPACES } from "@/lib/workspaces";
import { useSettings, type Workspace } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useWorkspaceName, WORKSPACE_ICONS } from "./workspaces";

/** Private | Business for one mailbox. */
export function WorkspacePicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Workspace;
  onChange: (workspace: Workspace) => void;
}) {
  const nameOf = useWorkspaceName();
  return (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      options={WORKSPACES.map((workspace) => {
        const Icon = WORKSPACE_ICONS[workspace];
        return {
          value: workspace,
          label: (
            <span className="flex items-center gap-1.5">
              <Icon className="size-3.5 shrink-0" aria-hidden />
              {nameOf(workspace)}
            </span>
          ),
        };
      })}
    />
  );
}

/** Nyu asks which mailboxes are business before the workspaces turn on. */
function WorkspaceSetup({
  accounts,
  onCancel,
  onDone,
  onDirtyChange,
}: {
  accounts: Account[];
  onCancel: () => void;
  onDone: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useT();
  const nameOf = useWorkspaceName();
  // Turned on again, the earlier choice is still ticked.
  const [initial] = useState(() => new Set(useSettings.getState().businessAccounts));
  const [business, setBusiness] = useState(() => new Set(initial));
  const dirty = business.size !== initial.size || [...business].some((id) => !initial.has(id));

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const toggle = (accountId: string) => {
    const next = new Set(business);
    if (!next.delete(accountId)) next.add(accountId);
    setBusiness(next);
  };
  const finish = () => {
    // Mailboxes removed meanwhile drop out of the list.
    const businessAccounts = accounts.filter((account) => business.has(account.id)).map((account) => account.id);
    useSettings.getState().update({ workspaces: true, businessAccounts });
    toast(t("workspace.enabled", { private: nameOf("private"), business: nameOf("business") }), "success");
    onDone();
  };

  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-5 pb-6 text-center">
      <NyuScene name="pick" className="w-40" />
      <h2 className="text-[18px] font-extrabold text-balance">
        {t("workspace.setupTitle", { name: nameOf("business") })}
      </h2>
      <p className="text-[13px] text-muted">{t("workspace.setupBody", { name: nameOf("private") })}</p>
      <ul className="flex w-full flex-col gap-2 text-left">
        {accounts.map((account) => {
          const checked = business.has(account.id);
          return (
            <li key={account.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggle(account.id)}
                className={clsx(
                  "flex w-full items-center gap-3 rounded-2xl border-2 px-3.5 py-2.5 text-left transition-colors",
                  checked ? "border-pink bg-pink-tint/60" : "border-line hover:border-pink-tint-strong",
                )}
              >
                <span
                  className={clsx(
                    "grid size-5 shrink-0 place-items-center rounded-md border-2 transition-colors",
                    checked ? "border-pink bg-pink text-white" : "border-line bg-surface",
                  )}
                  aria-hidden
                >
                  {checked && <Check className="size-3.5" strokeWidth={3} />}
                </span>
                <AccountDot color={account.color} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{account.email}</span>
                  <span className="block truncate text-[12.5px] text-muted">{account.displayName}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap justify-center gap-2 pt-1">
        <Button variant="primary" autoFocus onClick={finish}>
          {t("workspace.setupDone")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Settings → Mailboxes: keeping private and business apart, and what the two are called. */
export function WorkspaceSettings() {
  const { t } = useT();
  const enabled = useSettings((s) => s.workspaces);
  const names = useSettings((s) => s.workspaceNames);
  const update = useSettings((s) => s.update);
  const { data: accounts = [] } = useAccounts();
  const [settingUp, setSettingUp] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const requestClose = () => {
    if (dirty) setConfirmingDiscard(true);
    else setSettingUp(false);
  };

  return (
    <div className="flex flex-col gap-3 border-b border-hairline pb-4">
      <Toggle
        checked={enabled}
        onChange={(on) => {
          if (!on) update({ workspaces: false });
          else if (accounts.length === 0) update({ workspaces: true });
          else setSettingUp(true);
        }}
        label={t("workspace.setting")}
        description={t("workspace.settingDesc")}
      />
      {enabled && (
        <div className="grid gap-3 sm:grid-cols-2">
          {WORKSPACES.map((workspace) => (
            <Field key={workspace} label={t("workspace.nameOf", { name: t(`workspace.${workspace}`) })}>
              {(id) => (
                <TextInput
                  id={id}
                  value={names[workspace]}
                  maxLength={24}
                  placeholder={t(`workspace.${workspace}`)}
                  onChange={(event) => update({ workspaceNames: { ...names, [workspace]: event.target.value } })}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      <Dialog open={settingUp} onClose={requestClose} dismissable={!dirty} width="sm">
        {settingUp && (
          <WorkspaceSetup
            accounts={accounts}
            onCancel={requestClose}
            onDone={() => setSettingUp(false)}
            onDirtyChange={setDirty}
          />
        )}
      </Dialog>
      <ConfirmDiscardDialog
        open={confirmingDiscard}
        onKeepEditing={() => setConfirmingDiscard(false)}
        onDiscard={() => {
          setConfirmingDiscard(false);
          setSettingUp(false);
        }}
      />
    </div>
  );
}
