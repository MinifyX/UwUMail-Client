import clsx from "clsx";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { useUi } from "@/state/ui";
import type { Command } from "./commands";
import { KeyHint } from "./ShortcutsDialog";

export function CommandPalette({ commands }: { commands: Command[] }) {
  const { t } = useT();
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const hasThread = useUi((s) => s.selectedThreadId !== null);

  return (
    <Dialog open={open} onClose={() => setOpen(false)} width="md" className="mt-[12vh] self-start">
      {open && (
        <PaletteBody
          commands={commands.filter((c) => hasThread || !c.needsThread)}
          onClose={() => setOpen(false)}
          placeholder={t("palette.placeholder")}
          empty={t("palette.empty")}
        />
      )}
    </Dialog>
  );
}

function PaletteBody({
  commands,
  onClose,
  placeholder,
  empty,
}: {
  commands: Command[];
  onClose: () => void;
  placeholder: string;
  empty: string;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? commands.filter((c) => c.title.toLowerCase().includes(q)) : commands;
  }, [commands, query]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    void command.run();
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 border-b border-hairline px-5">
        <Search className="size-[18px] text-muted" aria-hidden />
        <input
          autoFocus
          value={query}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => (current + step + results.length) % Math.max(results.length, 1));
            }
            if (event.key === "Enter") run(results[active]);
          }}
          className="h-14 flex-1 bg-transparent text-[15px] outline-none"
        />
      </div>
      <ul className="max-h-[360px] overflow-y-auto p-2" role="listbox">
        {results.length === 0 && <li className="px-4 py-6 text-center text-[13px] text-muted">{empty}</li>}
        {results.map((command, index) => {
          const Icon = command.icon;
          return (
            <li
              key={command.id}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(command)}
              className={clsx(
                "flex h-11 cursor-pointer items-center gap-3 rounded-xl px-3",
                index === active && "bg-pink-tint",
              )}
            >
              <Icon className={clsx("size-[18px]", index === active ? "text-pink" : "text-muted")} aria-hidden />
              <span className="flex-1 text-[14px] font-medium">{command.title}</span>
              {command.keys?.[0] && <KeyHint combo={command.keys[0]} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
