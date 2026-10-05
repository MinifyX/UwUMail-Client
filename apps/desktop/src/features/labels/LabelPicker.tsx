import clsx from "clsx";
import { Check, Minus, Plus, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import type { LabelEntry } from "@/lib/labelFilter";
import { toast } from "@/state/toasts";
import { useUi, type LabelRequest } from "@/state/ui";
import { LABEL_COLORS, labelProblems } from "../assist/labels";
import { assistErrorText, useAssistScopes } from "../assist/useAssist";
import { filterLabelEntries, labelState, useLabelActions, type LabelState } from "./labelActions";
import { LabelDot } from "./LabelNav";
import { useLabelDirectory } from "./useLabels";

function PresenceMark({ state }: { state: LabelState }) {
  if (state === "all") return <Check className="size-3.5 shrink-0 text-pink" strokeWidth={3} aria-hidden />;
  if (state === "some") return <Minus className="size-3.5 shrink-0 text-muted" strokeWidth={3} aria-hidden />;
  return <span className="size-3.5 shrink-0" aria-hidden />;
}

/**
 * The quick label picker (L, "Labels…" in the list's context menu and the selection bar): type to
 * find a label, Enter or a click puts it on the chosen conversations or takes it off. A name that
 * is no label yet can be made right here, where all of the mail's labels live in one place.
 */
export function LabelPicker() {
  const { t } = useT();
  const request = useUi((s) => s.labeling);
  const close = useUi((s) => s.closeLabeling);
  return (
    <Dialog open={request !== null} onClose={close} title={t("labels.quick.title")} width="sm">
      {request && <PickerBody key={request.threadIds.join("|")} request={request} />}
    </Dialog>
  );
}

function PickerBody({ request }: { request: LabelRequest }) {
  const { t } = useT();
  const { entries } = useLabelDirectory();
  const { setOnMessages, messagesOf, refresh } = useLabelActions();
  const { data: allScopes = [] } = useAssistScopes();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // The dialog puts the focus on its close button; typing belongs in the search.
  useEffect(() => {
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    let live = true;
    void messagesOf(request.threadIds).then((found) => live && setMessages(found));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const accountIds = new Set((messages ?? []).map((message) => message.accountId));
  const usable = entries.filter((entry) => entry.accountIds.some((id) => accountIds.has(id)));
  const shown = filterLabelEntries(usable, query);
  const name = query.trim();
  // A new label goes where all of the mail's labels live; mail of several places gets none.
  const places = allScopes.filter((scope) => scope.accountIds.some((id) => accountIds.has(id)));
  const place = places.length === 1 ? places[0]! : null;
  const placeLabels = place ? usable.filter((entry) => entry.scope === place.id).map((entry) => entry.label) : [];
  const canCreate =
    name !== "" &&
    place !== null &&
    placeLabels.filter((label) => !label.base).length < place.options.maxLabels &&
    Object.keys(labelProblems({ name, description: "", color: null }, placeLabels)).length === 0;
  const count = shown.length + (canCreate ? 1 : 0);
  const current = Math.min(active, Math.max(0, count - 1));

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current]);

  const toggle = async (entry: LabelEntry) => {
    if (!messages) return;
    const on = labelState(messages, entry) !== "all";
    setBusy(true);
    try {
      await setOnMessages(messages, entry, on);
      toast(
        t(on ? "labels.quick.added" : "labels.quick.removed", {
          name: entry.label.name,
          count: request.threadIds.length,
        }),
        "success",
      );
      setMessages(await messagesOf(request.threadIds));
    } catch {
      // Shown by the action already.
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!place || !messages) return;
    setBusy(true);
    try {
      const label = await backend().createAssistLabel(place.id, {
        name,
        description: "",
        color: LABEL_COLORS[placeLabels.length % LABEL_COLORS.length]!,
      });
      await setOnMessages(messages, { scope: place.id, accountIds: place.accountIds, label }, true);
      toast(t("labels.createdApplied", { name: label.name }), "success");
      setQuery("");
      setActive(0);
      refresh();
      setMessages(await messagesOf(request.threadIds));
    } catch (error) {
      toast(assistErrorText(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const choose = (index: number) => {
    if (busy || !messages) return;
    const entry = shown[index];
    if (entry) void toggle(entry);
    else if (canCreate) void create();
  };

  return (
    <div className="flex flex-col gap-2 px-5 pt-1 pb-5">
      <p className="text-[12.5px] text-muted">{t("labels.quick.for", { count: request.threadIds.length })}</p>
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          ref={input}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={count > 0 ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          aria-label={t("labels.quick.search")}
          placeholder={t("labels.quick.search")}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (count > 0) setActive((current + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
            } else if (event.key === "Enter") {
              // An IME's Enter confirms the word, it doesn't pick a label.
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              choose(current);
            }
          }}
          className="h-10 w-full rounded-full border border-line bg-canvas pr-3 pl-9 text-[13.5px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none"
        />
      </div>
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-label={t("labels.quick.title")}
        aria-busy={busy || messages === null}
        className="flex max-h-[min(420px,60vh)] flex-col gap-0.5 overflow-y-auto"
      >
        {shown.map((entry, index) => {
          const state = messages ? labelState(messages, entry) : "none";
          return (
            <li
              key={`${entry.scope}:${entry.label.id}`}
              id={`${listId}-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === current}
              aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
              onClick={() => choose(index)}
              onPointerMove={() => setActive(index)}
              className={clsx(
                "flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-[13.5px]",
                index === current && "bg-pink-tint/60",
                busy && "opacity-60",
              )}
            >
              <PresenceMark state={state} />
              <LabelDot color={entry.label.color} />
              <span className="min-w-0 flex-1 truncate">{entry.label.name}</span>
            </li>
          );
        })}
        {canCreate && (
          <li
            id={`${listId}-${shown.length}`}
            data-index={shown.length}
            role="option"
            aria-selected={current === shown.length}
            onClick={() => choose(shown.length)}
            onPointerMove={() => setActive(shown.length)}
            className={clsx(
              "flex h-9 shrink-0 cursor-pointer items-center gap-2.5 rounded-xl px-3 text-[13.5px] font-semibold text-pink-ink",
              current === shown.length && "bg-pink-tint/60",
              busy && "opacity-60",
            )}
          >
            <Plus className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{t("labels.quick.create", { name })}</span>
          </li>
        )}
        {messages === null && <li className="px-3 py-2 text-[13px] text-muted">{t("list.loading")}</li>}
        {count === 0 && messages !== null && (
          <li className="px-3 py-2 text-[13px] text-muted">
            {name ? t("labels.quick.noMatch") : t("labels.quick.none")}
          </li>
        )}
      </ul>
    </div>
  );
}
