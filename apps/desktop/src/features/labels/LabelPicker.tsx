import clsx from "clsx";
import { Check, Minus, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import type { LabelEntry } from "@/lib/labelFilter";
import { toast } from "@/state/toasts";
import { useUi, type LabelRequest } from "@/state/ui";
import { assistErrorText, useAssistScopes } from "../assist/useAssist";
import { LABEL_COLORS } from "../assist/labels";
import { labelState, useLabelActions } from "./labelActions";
import { LabelDot } from "./LabelNav";
import { useLabelDirectory } from "./useLabels";

/** The label picker (L, the list's context menu, the selection bar): ticks labels on and off. */
export function LabelPicker() {
  const { t } = useT();
  const request = useUi((s) => s.labeling);
  const close = useUi((s) => s.closeLabeling);
  return (
    <Dialog open={request !== null} onClose={close} title={t("labels.pickerTitle")} width="sm">
      {request && <LabelChoices key={request.threadIds.join("|")} request={request} />}
    </Dialog>
  );
}

function LabelChoices({ request }: { request: LabelRequest }) {
  const { t } = useT();
  const { entries } = useLabelDirectory();
  const { setOnMessages, messagesOf, refresh } = useLabelActions();
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

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
  const query = search.trim().toLowerCase();
  const shown = usable.filter((entry) => !query || entry.label.name.toLowerCase().includes(query));
  // A new label goes where all of the mail's labels live; mail of several places gets none.
  const { data: allScopes = [] } = useAssistScopes();
  const scopes = allScopes.filter((scope) => scope.accountIds.some((id) => accountIds.has(id)));
  const exact = usable.some((entry) => entry.label.name.trim().toLowerCase() === query);

  const toggle = async (entry: LabelEntry) => {
    if (!messages) return;
    const on = labelState(messages, entry) !== "all";
    setBusy(entry.label.id);
    try {
      await setOnMessages(messages, entry, on);
      setMessages(await messagesOf(request.threadIds));
    } catch {
      // Shown by the action already.
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const place = scopes[0];
    if (!place || !messages) return;
    const scope = place.id;
    setBusy("new");
    try {
      const label = await backend().createAssistLabel(scope, {
        name: search.trim(),
        description: "",
        color: LABEL_COLORS[usable.length % LABEL_COLORS.length]!,
      });
      await setOnMessages(messages, { scope, accountIds: place.accountIds, label }, true);
      toast(t("labels.createdApplied", { name: label.name }), "success");
      setSearch("");
      refresh();
      setMessages(await messagesOf(request.threadIds));
    } catch (error) {
      toast(assistErrorText(error), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
          aria-hidden
        />
        <input
          type="search"
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            if (shown.length > 0) void toggle(shown[0]!);
            else if (query && scopes.length === 1) void create();
          }}
          placeholder={t("labels.pickerSearch")}
          aria-label={t("labels.pickerSearch")}
          className="h-10 w-full rounded-full border border-transparent bg-canvas pr-4 pl-10 text-[13.5px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <ul className="flex max-h-[min(420px,60vh)] flex-col gap-0.5 overflow-y-auto">
        {messages === null ? (
          <li className="px-3 py-6 text-center text-[13px] text-muted">{t("list.loading")}</li>
        ) : (
          <>
            {shown.length === 0 && !query && (
              <li className="px-3 py-6 text-center text-[13px] text-muted">{t("labels.pickerEmpty")}</li>
            )}
            {shown.map((entry) => {
              const state = labelState(messages, entry);
              return (
                <li key={`${entry.scope}:${entry.label.id}`}>
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={state === "all" ? true : state === "some" ? "mixed" : false}
                    disabled={busy !== null}
                    onClick={() => void toggle(entry)}
                    className="flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13.5px] hover:bg-pink-tint/60 focus-visible:bg-pink-tint/60 focus-visible:outline-none disabled:opacity-60"
                  >
                    <span
                      aria-hidden
                      className={clsx(
                        "grid size-[18px] shrink-0 place-items-center rounded-[6px] border-2",
                        state === "none" ? "border-line" : "border-pink bg-pink text-white",
                      )}
                    >
                      {state === "all" && <Check className="size-3" strokeWidth={3.5} />}
                      {state === "some" && <Minus className="size-3" strokeWidth={3.5} />}
                    </span>
                    <LabelDot color={entry.label.color} />
                    <span className="min-w-0 flex-1 truncate">{entry.label.name}</span>
                  </button>
                </li>
              );
            })}
            {query && !exact && scopes.length === 1 && (
              <li>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void create()}
                  className="flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13.5px] font-semibold text-pink-ink hover:bg-pink-tint/60 focus-visible:bg-pink-tint/60 focus-visible:outline-none disabled:opacity-60"
                >
                  <Plus className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t("labels.createNamed", { name: search.trim() })}</span>
                </button>
              </li>
            )}
            {query && shown.length === 0 && scopes.length !== 1 && (
              <li className="px-3 py-6 text-center text-[13px] text-muted">{t("labels.pickerNone")}</li>
            )}
          </>
        )}
      </ul>
    </div>
  );
}
