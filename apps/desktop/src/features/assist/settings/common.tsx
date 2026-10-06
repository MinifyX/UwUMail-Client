import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, Info, TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { backend } from "@/backend/backend";
import type { AssistProbeInput } from "@/backend/types";
import { IconButton, TextInput } from "@uwusuite/design";
import { useT } from "@/i18n";
import { useAssistScope } from "../useAssist";

/** A part of the assistant's settings: a small heading, what it is about, and its content. */
export function Section({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-b border-hairline pb-5 last:border-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-[min(100%,14rem)] flex-1">
          <h3 className="text-sm font-bold">{title}</h3>
          {description && <p className="text-[13px] text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A quiet note, or a warning. */
export function Note({ tone = "info", children }: { tone?: "info" | "warning"; children: ReactNode }) {
  const Icon = tone === "warning" ? TriangleAlert : Info;
  return (
    <div
      className={clsx(
        "flex gap-2 rounded-2xl px-3.5 py-2.5 text-[12.5px]",
        tone === "warning" ? "bg-warning-tint text-warning" : "bg-canvas text-muted",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The models a provider offers, asked for only once somebody wants to pick one. */
export function useProviderModels(providerId: string | null, wanted: boolean, probe?: AssistProbeInput | null) {
  const scope = useAssistScope();
  // An address not saved yet is asked directly; its key never goes into the cache's key.
  const unsaved = !providerId && probe ? probe : null;
  return useQuery({
    queryKey: unsaved
      ? ["assistModels", scope, "probe", unsaved.kind, unsaved.baseUrl, Boolean(unsaved.apiKey)]
      : ["assistModels", scope, providerId],
    queryFn: () => (unsaved ? backend().assistProbeModels(unsaved) : backend().assistModels(scope, providerId!)),
    enabled: wanted && (Boolean(providerId) || unsaved !== null),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * A model name: typed, or picked from the provider's list (the button next to the field), which
 * is asked for when the field is first used. Saves on leaving the field, Enter, or a pick.
 */
export function ModelInput({
  providerId,
  probe,
  value,
  placeholder,
  label,
  onCommit,
  className,
}: {
  providerId: string | null;
  /** A provider being added at its own address: its models before it is saved (this device only). */
  probe?: AssistProbeInput | null;
  value: string;
  placeholder?: string;
  label: string;
  onCommit?: (value: string) => void;
  className?: string;
}) {
  const { t } = useT();
  const [wanted, setWanted] = useState(false);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  // A new value from outside (another provider picked) replaces what was typed.
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const { data, isFetching, isError } = useProviderModels(providerId, wanted, probe);
  const models = data?.models ?? [];
  const canList = Boolean(providerId) || Boolean(probe);
  const commit = (next = text) => {
    if (next.trim() !== value) onCommit?.(next.trim());
  };
  const pick = (id: string) => {
    setText(id);
    setOpen(false);
    commit(id);
  };
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  return (
    <div ref={root} className="relative flex min-w-0 items-center gap-1">
      <TextInput
        aria-label={label}
        value={text}
        placeholder={placeholder}
        list={listId}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => setWanted(true)}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "ArrowDown" && event.altKey && canList) {
            event.preventDefault();
            setWanted(true);
            setOpen(true);
          }
        }}
        className={clsx("h-9 min-w-0 flex-1 text-[13px]", className)}
      />
      <datalist id={listId}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name !== model.id ? model.name : undefined}
          </option>
        ))}
      </datalist>
      {canList && (
        <IconButton
          icon={ChevronDown}
          size="sm"
          label={t("assist.providers.pickModel", { field: label })}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            setWanted(true);
            setOpen(!open);
          }}
        />
      )}
      {open && (
        <div
          role="listbox"
          aria-label={label}
          className="absolute top-[calc(100%+4px)] right-0 left-0 z-40 flex max-h-64 animate-pop flex-col overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-float"
        >
          {isFetching && models.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-muted">{t("assist.providers.modelsLoading")}</p>
          ) : models.length === 0 ? (
            <p className="px-3 py-2 text-[12.5px] text-muted">
              {isError ? t("assist.providers.modelsFailed") : t("assist.providers.modelsNone")}
            </p>
          ) : (
            models.map((model) => (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={model.id === text.trim()}
                onClick={() => pick(model.id)}
                className={clsx(
                  "rounded-xl px-3 py-1.5 text-left text-[13px] break-all hover:bg-pink-tint/60 focus:bg-pink-tint/60 focus:outline-none",
                  model.id === text.trim() && "font-semibold text-pink-ink",
                )}
              >
                {model.id}
                {model.name !== model.id && <span className="ml-1.5 text-[12px] text-muted">{model.name}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
