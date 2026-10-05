import clsx from "clsx";
import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { backend } from "@/backend/backend";
import type { Address, Contact } from "@/backend/types";
import { Avatar } from "@/components/ui/Avatar";
import { useT } from "@/i18n";
import { displayName, parseAddress } from "@/lib/format";

interface RecipientInputProps {
  label: string;
  value: Address[];
  onChange: (value: Address[]) => void;
  autoFocus?: boolean;
}

export function RecipientInput({ label, value, onChange, autoFocus }: RecipientInputProps) {
  const { t } = useT();
  const id = useId();
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused || text.trim().length === 0) return;
    let cancelled = false;
    void backend()
      .searchContacts(text)
      .then((result) => {
        if (cancelled) return;
        const taken = new Set(value.map((a) => a.email.toLowerCase()));
        setSuggestions(result.filter((c) => !taken.has(c.email.toLowerCase())));
        setActive(0);
      });
    return () => {
      cancelled = true;
    };
  }, [text, focused, value]);

  const add = (address: Address) => {
    if (!value.some((a) => a.email.toLowerCase() === address.email.toLowerCase())) onChange([...value, address]);
    setText("");
    setSuggestions([]);
  };

  const commitText = () => {
    const parts = text
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean);
    const parsed = parts.map(parseAddress);
    if (parsed.length === 0 || parsed.some((p) => p === null)) return false;
    onChange([...value, ...(parsed as Address[])]);
    setText("");
    return true;
  };

  const listId = `${id}-suggestions`;
  const open = focused && text.trim().length > 0 && suggestions.length > 0;

  return (
    <div className="relative flex min-h-11 items-start gap-2 border-b border-hairline px-4 py-1.5">
      <label htmlFor={id} className="w-12 shrink-0 pt-2 text-[13px] font-semibold text-muted">
        {label}
      </label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {value.map((address) => (
          <span
            key={address.email}
            title={address.email}
            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-pink-tint pr-1 pl-2.5 text-[13px] font-medium text-pink-ink"
          >
            {displayName(address)}
            <button
              type="button"
              aria-label={t("compose.removeRecipient", { email: address.email })}
              onClick={() => onChange(value.filter((a) => a !== address))}
              className="grid size-5 place-items-center rounded-full hover:bg-pink-tint-strong"
            >
              <X className="size-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (text.trim()) commitText();
          }}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current) => (current + step + suggestions.length) % suggestions.length);
            } else if ((event.key === "Enter" || event.key === "Tab") && open) {
              event.preventDefault();
              const pick = suggestions[active];
              if (pick) add({ name: pick.name, email: pick.email });
            } else if ((event.key === "Enter" || event.key === "," || event.key === ";") && text.trim()) {
              if (commitText()) event.preventDefault();
            } else if (event.key === "Backspace" && !text && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          className="h-8 min-w-[140px] flex-1 bg-transparent text-[14px] outline-none"
        />
      </div>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-4 left-16 z-10 mt-1 animate-fade overflow-hidden rounded-2xl border border-line bg-surface p-1 shadow-float"
        >
          {suggestions.map((contact, index) => (
            <li
              key={contact.email}
              role="option"
              aria-selected={index === active}
              onMouseDown={(event) => {
                event.preventDefault();
                add({ name: contact.name, email: contact.email });
              }}
              className={clsx(
                "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2",
                index === active ? "bg-pink-tint" : "hover:bg-elevated",
              )}
            >
              <Avatar address={contact} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-semibold">{displayName(contact)}</span>
                <span className="block truncate text-[12px] text-muted">{contact.email}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
