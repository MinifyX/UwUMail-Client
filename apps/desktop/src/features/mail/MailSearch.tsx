import clsx from "clsx";
import { Icon, IconButton, ICONS } from "@uwusuite/design";
import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import { withSearchTerm } from "@/lib/searchQuery";
import { modKey } from "@/lib/platform";
import { useUi } from "@/state/ui";
import { SearchHelp } from "./SearchHelp";

export const SEARCH_INPUT_ID = "uwu-search";

/**
 * The mail search. In the list header, or in the middle of the title bar on Windows and Linux
 * (`compact`, 28 px). Only one of them is on screen, so ⌘K/Ctrl+K finds it by id.
 */
export function MailSearch({ compact = false, className }: { compact?: boolean; className?: string }) {
  const { t } = useT();
  const search = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  const [draft, setDraft] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(draft), 180);
    return () => clearTimeout(timer);
  }, [draft, setSearch]);

  return (
    <div className={clsx("relative", className)}>
      <Icon
        icon={ICONS.search}
        size={compact ? "sm" : "md"}
        className={clsx(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted",
          compact ? "left-2.5" : "left-3.5",
        )}
      />
      <input
        id={SEARCH_INPUT_ID}
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft("");
            event.currentTarget.blur();
          }
        }}
        placeholder={compact ? t("titlebar.search") : t("list.search")}
        aria-label={t("list.search")}
        className={clsx(
          "w-full border placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden",
          compact
            ? "h-7 rounded-[10px] border-hairline bg-canvas pr-16 pl-8 text-[12.5px]"
            : "h-10 rounded-full border-transparent bg-canvas pr-[4.5rem] pl-10 text-[13.5px]",
        )}
      />
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
        {compact && !draft && (
          <kbd className="pointer-events-none mr-1 rounded-md border border-hairline px-1.5 font-sans text-[10.5px] font-semibold text-muted">
            {modKey} K
          </kbd>
        )}
        {!compact && (
          <SearchHelp
            onInsert={(term) => {
              setDraft(withSearchTerm(draft, term));
              document.getElementById(SEARCH_INPUT_ID)?.focus();
            }}
          />
        )}
        {draft && (
          <IconButton icon={ICONS.close} size="sm" label={t("list.clearSearch")} onClick={() => setDraft("")} />
        )}
      </div>
    </div>
  );
}
