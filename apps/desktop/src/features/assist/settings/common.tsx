import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Info, TriangleAlert } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { backend } from "@/backend/backend";
import { useAssistScope } from "../useAssist";
import { TextInput } from "@/components/ui/Field";

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
export function useProviderModels(providerId: string | null, wanted: boolean) {
  const scope = useAssistScope();
  return useQuery({
    queryKey: ["assistModels", scope, providerId],
    queryFn: () => backend().assistModels(scope, providerId!),
    enabled: wanted && Boolean(providerId),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/**
 * A model name: typed, or picked from the provider's list, which is asked for when the field is
 * first used. Saves on leaving the field or Enter.
 */
export function ModelInput({
  providerId,
  value,
  placeholder,
  label,
  onCommit,
  className,
}: {
  providerId: string | null;
  value: string;
  placeholder?: string;
  label: string;
  onCommit?: (value: string) => void;
  className?: string;
}) {
  const [wanted, setWanted] = useState(false);
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  // A new value from outside (another provider picked) replaces what was typed.
  if (shown !== value) {
    setShown(value);
    setText(value);
  }
  const listId = useId();
  const { data } = useProviderModels(providerId, wanted);
  const commit = () => {
    if (text.trim() !== value) onCommit?.(text.trim());
  };
  return (
    <>
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
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        className={clsx("h-9 text-[13px]", className)}
      />
      <datalist id={listId}>
        {data?.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name !== model.id ? model.name : undefined}
          </option>
        ))}
      </datalist>
    </>
  );
}
