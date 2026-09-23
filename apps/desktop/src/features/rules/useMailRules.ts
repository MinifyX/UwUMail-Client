import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { backend } from "@/backend/backend";
import { translate } from "@/i18n";
import { emptyRuleSet, parseRulesScript, rulesToSieve, type ParsedRules, type RuleSet } from "@/lib/sieveRules";
import { useAccounts } from "@/lib/queries";
import { toast } from "@/state/toasts";

export const MAIL_RULES_KEY = ["mailRules"] as const;

/** The mailboxes whose server keeps mail rules; the settings leave the section out when there is none. */
export function useMailRulesAccounts() {
  const { data: accounts = [] } = useAccounts();
  const ids = accounts.map((account) => account.id);
  return useQuery({
    queryKey: ["mailRulesAvailable", ids],
    queryFn: async () => {
      const available = await Promise.all(ids.map((id) => backend().mailRulesAvailable(id)));
      return accounts.filter((_, index) => available[index]);
    },
    enabled: ids.length > 0,
    staleTime: Infinity,
  });
}

export interface MailRulesState {
  parsed: ParsedRules;
  /** False when the script exists but another one (or none) filters the mail. */
  active: boolean;
  exists: boolean;
}

/** The account's rules as the editor sees them, and the one way to store them. */
export function useMailRules(accountId: string) {
  const client = useQueryClient();
  const key = [...MAIL_RULES_KEY, accountId];
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<MailRulesState> => {
      const { script, active } = await backend().mailRules(accountId);
      return {
        parsed: script === null ? { kind: "rules", set: emptyRuleSet() } : parseRulesScript(script),
        active,
        exists: script !== null,
      };
    },
    retry: false,
  });
  const [saving, setSaving] = useState(false);

  /** Checks the script with the server, stores it and switches it on. Resolves whether it worked. */
  const saveScript = async (script: string, next: ParsedRules): Promise<boolean> => {
    setSaving(true);
    try {
      const problem = await backend().validateMailRules(script, accountId);
      if (problem) {
        toast(translate("rules.invalid", { reason: problem }), "error");
        return false;
      }
      await backend().saveMailRules(script, accountId);
      client.setQueryData<MailRulesState>(key, { parsed: next, active: true, exists: true });
      return true;
    } catch (error) {
      toast(translate("rules.saveFailed", { reason: error instanceof Error ? error.message : String(error) }), "error");
      return false;
    } finally {
      setSaving(false);
      void client.invalidateQueries({ queryKey: key });
    }
  };

  return {
    query,
    saving,
    save: (set: RuleSet) => saveScript(rulesToSieve(set), { kind: "rules", set }),
    saveText: (text: string) => saveScript(text, parseRulesScript(text)),
  };
}
