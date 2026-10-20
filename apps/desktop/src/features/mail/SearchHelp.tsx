import { IconButton, ICONS, Menu } from "@uwusuite/design";
import { useT } from "@/i18n";
import { SEARCH_OPERATORS, type SearchOperatorKey } from "@/lib/searchQuery";

/** Today as `YYYY-MM-DD`, in local time, for the date operators' examples. */
function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The term a help entry adds to the search; the dates start out as today. */
export function operatorTerm(key: SearchOperatorKey): string {
  const entry = SEARCH_OPERATORS.find((operator) => operator.key === key)!;
  return key === "after" || key === "before" ? `${entry.example}${today()}` : entry.example;
}

/** The "?" in the search field: what the search understands, and a click adds it. */
export function SearchHelp({ onInsert }: { onInsert: (term: string) => void }) {
  const { t } = useT();
  return (
    <Menu
      align="end"
      items={[
        { heading: t("searchHelp.title") },
        ...SEARCH_OPERATORS.map((operator) => ({
          label: (
            <span className="flex min-w-0 flex-col">
              <code className="font-mono text-[12.5px] font-semibold">{t(`searchHelp.example.${operator.key}`)}</code>
              <span className="text-[12px] text-muted">{t(`searchHelp.desc.${operator.key}`)}</span>
            </span>
          ),
          onSelect: () => onInsert(operatorTerm(operator.key)),
        })),
        "separator" as const,
        { heading: t("searchHelp.hint") },
      ]}
      trigger={(menu) => (
        <IconButton
          icon={ICONS.help}
          size="sm"
          label={t("searchHelp.open")}
          onClick={menu.toggle}
          aria-haspopup={menu["aria-haspopup"]}
          aria-expanded={menu["aria-expanded"]}
          aria-controls={menu["aria-controls"]}
        />
      )}
    />
  );
}
