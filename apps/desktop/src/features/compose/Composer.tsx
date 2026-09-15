import clsx from "clsx";
import {
  ArrowLeft,
  Bold,
  Check,
  ChevronDown,
  Italic,
  Link,
  List,
  Maximize2,
  Minimize2,
  Paperclip,
  PenLine,
  Send,
  Trash,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "@/backend/backend";
import type { OutgoingAttachment } from "@/backend/types";
import { useBackLayer } from "@/lib/backStack";
import { useIsPhone } from "@/lib/device";
import { clearLocalDraft, markLocalDraftSaved, saveLocalDraft } from "./localDraft";
import { AccountDot } from "@/components/ui/Avatar";
import { Button, IconButton } from "@/components/ui/Button";
import { useT } from "@/i18n";
import { formatSize } from "@/lib/format";
import { modKey } from "@/lib/platform";
import { htmlToPlainText, isSafeLinkTarget, quotableHtml } from "@/lib/safeHtml";
import { useAccounts, useMessageActions } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { useUi, type ComposeRequest } from "@/state/ui";
import { initialDraft, type DraftState } from "./draft";
import { RecipientInput } from "./RecipientInput";

/** Quiet for this long after the last change, then the draft goes to the server. */
const DRAFT_SAVE_DELAY = 2500;
/** While someone keeps typing, it still goes at least this often. */
const DRAFT_SAVE_MAX_WAIT = 15_000;

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; at: string } | { kind: "local" };

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function Composer() {
  const request = useUi((s) => s.compose);
  if (!request) return null;
  return <ComposerWindow key={request.key} request={request} />;
}

function ComposerWindow({ request }: { request: ComposeRequest }) {
  const { t, i18n } = useT();
  const { data: accounts = [] } = useAccounts();
  const closeCompose = useUi((s) => s.closeCompose);
  const minimized = useUi((s) => s.composeMinimized);
  const setMinimized = useUi((s) => s.setComposeMinimized);
  const { refresh } = useMessageActions();

  // The draft is created once per compose request (the component is keyed by it).
  const [initial] = useState(() => initialDraft(request, accounts, t, i18n.language));
  const [draft, setDraft] = useState<DraftState>(initial);
  const accountId = draft.accountId || accounts[0]?.id || "";
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [large, setLarge] = useState(false);
  const [attachments, setAttachments] = useState<OutgoingAttachment[]>(request.attachments ?? []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // The body lives outside React, so it survives minimizing (the editor unmounts meanwhile).
  const body = useRef(initial.html);
  const [edits, setEdits] = useState(0);
  const phone = useIsPhone();
  // On the phone the back gesture shrinks the draft to a bar instead of losing it.
  useBackLayer(phone && !minimized, () => setMinimized(true));

  const inReplyTo = request.mode === "forward" ? undefined : (request.restore?.inReplyTo ?? request.source?.id);
  // Drafts: changed since the last save, the key of the server copy and where it lives.
  const dirty = useRef(request.restore?.savedToServer === false);
  const draftKey = useRef(request.restore?.draftKey);
  const savedAccount = useRef(request.restore?.draftKey ? request.restore.accountId : undefined);
  const lastSave = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());
  /** Sent or thrown away: nothing may save the draft again. */
  const finished = useRef(false);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const latest = useRef({ draft, accountId, attachments });
  useEffect(() => {
    latest.current = { draft, accountId, attachments };
  });

  const localCopy = useCallback(
    (savedToServer: boolean) => {
      const { draft: current } = latest.current;
      saveLocalDraft({
        mode: request.mode,
        accountId: latest.current.accountId,
        to: current.to,
        cc: current.cc,
        bcc: current.bcc,
        subject: current.subject,
        html: body.current,
        inReplyTo,
        draftKey: draftKey.current,
        savedToServer,
      });
    },
    [request.mode, inReplyTo],
  );

  /** Saves the draft into the Drafts folder, one save after the other. */
  const saveDraft = useCallback(() => {
    const run = async () => {
      if (!dirty.current || finished.current) return;
      dirty.current = false;
      lastSave.current = Date.now();
      const { draft: current, accountId: account, attachments: files } = latest.current;
      const html = quotableHtml(editor.current?.innerHTML ?? body.current);
      setSaveState({ kind: "saving" });
      try {
        const saved = await backend().saveDraft({
          accountId: account,
          to: current.to,
          cc: current.cc,
          bcc: current.bcc,
          subject: current.subject,
          html,
          text: htmlToPlainText(html),
          inReplyTo,
          attachments: files,
          draftKey: draftKey.current,
        });
        // Written from another mailbox now: the old copy goes.
        const previous = savedAccount.current;
        if (previous && previous !== account)
          void backend()
            .deleteDraft(previous, saved.draftKey)
            .catch(() => {});
        draftKey.current = saved.draftKey;
        savedAccount.current = account;
        if (!dirty.current) markLocalDraftSaved(saved.draftKey);
        setSaveState({ kind: "saved", at: saved.savedAt });
      } catch {
        // Kept on this device; the next change or closing tries again.
        dirty.current = true;
        setSaveState({ kind: "local" });
      }
    };
    saving.current = saving.current.then(run);
    return saving.current;
  }, [inReplyTo]);

  const changed = () => {
    dirty.current = true;
  };

  useEffect(() => {
    if (!dirty.current || finished.current) return;
    const local = window.setTimeout(() => localCopy(false), 500);
    const sinceSave = Date.now() - lastSave.current;
    const server = window.setTimeout(
      () => void saveDraft(),
      Math.max(0, Math.min(DRAFT_SAVE_DELAY, DRAFT_SAVE_MAX_WAIT - sinceSave)),
    );
    return () => {
      window.clearTimeout(local);
      window.clearTimeout(server);
    };
  }, [draft, edits, attachments, localCopy, saveDraft]);

  // Replaced by another compose window or closed from elsewhere: nothing typed gets lost.
  useEffect(
    () => () => {
      if (dirty.current && !finished.current) {
        localCopy(false);
        void saveDraft();
      }
    },
    [localCopy, saveDraft],
  );

  /** Closes the window; the draft stays in the Drafts folder. */
  const close = () => {
    const worthKeeping = dirty.current || draftKey.current !== undefined;
    closeCompose();
    if (!worthKeeping) {
      clearLocalDraft();
      return;
    }
    if (dirty.current) localCopy(false);
    void saveDraft().then(() => {
      if (dirty.current) {
        toast(t("toast.draftLocal"), "error");
      } else {
        clearLocalDraft();
        toast(t("toast.draftSaved"), "success");
      }
    });
  };

  /** Throws the draft away, also from the Drafts folder. */
  const discard = () => {
    const hadDraft = draftKey.current !== undefined || dirty.current;
    finished.current = true;
    clearLocalDraft();
    closeCompose();
    // After a save that may still be on its way, so it can't bring the draft back.
    void saving.current.then(async () => {
      const key = draftKey.current;
      const account = savedAccount.current;
      if (key && account)
        await backend()
          .deleteDraft(account, key)
          .catch(() => {});
    });
    if (hadDraft) toast(t("toast.draftDiscarded"));
  };

  useEffect(() => {
    if (request.mode !== "new") {
      editor.current?.focus();
      const selection = window.getSelection();
      if (editor.current && selection) {
        selection.selectAllChildren(editor.current);
        selection.collapseToStart();
      }
    }
  }, [initial, request.mode]);

  const update = (patch: Partial<DraftState>) => {
    setError(null);
    changed();
    setDraft((current) => ({ ...current, ...patch }));
  };

  const format = (command: "bold" | "italic" | "insertUnorderedList" | "createLink") => {
    editor.current?.focus();
    if (command === "createLink") {
      const url = window.prompt(t("compose.linkPrompt"), "https://");
      if (url && isSafeLinkTarget(url)) document.execCommand("createLink", false, url.trim());
      return;
    }
    document.execCommand(command);
  };

  const send = async () => {
    if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
      setError(t("compose.noRecipients"));
      return;
    }
    // What people paste can carry forms or remote content; send only the safe part.
    const html = quotableHtml(editor.current?.innerHTML ?? body.current);
    setSending(true);
    finished.current = true;
    try {
      await saving.current;
      await backend().send({
        accountId,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html,
        text: htmlToPlainText(html),
        inReplyTo,
        attachments,
        draftKey: savedAccount.current === accountId ? draftKey.current : undefined,
      });
      // Written in another mailbox before: sending there doesn't remove that copy.
      if (draftKey.current && savedAccount.current && savedAccount.current !== accountId) {
        void backend()
          .deleteDraft(savedAccount.current, draftKey.current)
          .catch(() => {});
      }
      toast(t("toast.sent"), "success", "sent");
      clearLocalDraft();
      closeCompose();
      void refresh();
    } catch (reason) {
      finished.current = false;
      setError(t("toast.sendFailed", { reason: reason instanceof Error ? reason.message : String(reason) }));
    } finally {
      setSending(false);
    }
  };

  const title =
    draft.subject ||
    t(request.mode === "forward" ? "compose.forward" : request.mode === "new" ? "compose.new" : "compose.reply");
  const account = accounts.find((a) => a.id === accountId);

  if (minimized && phone) {
    const names = [...draft.to, ...draft.cc].map((a) => a.name || a.email).join(", ");
    return (
      <div className="fixed inset-x-3 bottom-[84px] z-30 flex animate-slide-up items-center gap-2 rounded-2xl bg-[#1c1420] py-1.5 pr-1.5 pl-4 text-white shadow-float dark:bg-elevated dark:text-ink">
        <PenLine className="size-4 shrink-0 text-[#ff7fac]" aria-hidden />
        <button type="button" onClick={() => setMinimized(false)} className="min-w-0 flex-1 py-1 text-left">
          <span className="block truncate text-[13.5px] font-bold">
            {names ? t("mobile.draft.to", { names }) : title}
            {names && draft.subject ? `: ${draft.subject}` : ""}
          </span>
          <span className="block text-[12px] opacity-70">{t("mobile.draft.continue")}</span>
        </button>
        <button
          type="button"
          onClick={discard}
          aria-label={t("compose.discard")}
          title={t("compose.discard")}
          className="grid size-10 shrink-0 place-items-center rounded-full hover:bg-white/10"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
    );
  }

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed right-6 bottom-0 z-40 flex h-12 w-80 items-center gap-3 rounded-t-2xl bg-[#1c1420] px-4 text-left text-[13.5px] font-semibold text-white shadow-float dark:bg-elevated dark:text-ink"
      >
        <Send className="size-4 text-[#ff7fac]" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <ChevronDown className="size-4 rotate-180" aria-hidden />
      </button>
    );
  }

  return (
    <section
      role="dialog"
      aria-label={title}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void send();
        }
        if (event.key === "Escape") setMinimized(true);
      }}
      className={clsx(
        "fixed z-40 flex animate-slide-up flex-col overflow-hidden bg-surface",
        phone
          ? "inset-0"
          : large
            ? "inset-x-[max(24px,calc(50vw-460px))] top-10 bottom-10 rounded-[22px] border border-line shadow-float"
            : "right-6 bottom-6 h-[min(620px,calc(100vh-48px))] w-[min(580px,calc(100vw-48px))] rounded-[22px] border border-line shadow-float",
      )}
    >
      <header
        className={clsx(
          "flex items-center gap-1 bg-[#1c1420] pr-2 text-white dark:bg-elevated dark:text-ink",
          phone ? "py-1.5 pl-1.5" : "py-2 pl-5",
        )}
      >
        {phone && (
          <button
            type="button"
            onClick={() => setMinimized(true)}
            aria-label={t("compose.minimize")}
            title={t("compose.minimize")}
            className="grid size-10 place-items-center rounded-full hover:bg-white/10"
          >
            <ArrowLeft className="size-5" aria-hidden />
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate text-[14px] font-bold">{title}</h2>
        {!phone && (
          <>
            <button
              type="button"
              onClick={() => setMinimized(true)}
              aria-label={t("compose.minimize")}
              title={t("compose.minimize")}
              className="grid size-8 place-items-center rounded-full hover:bg-white/10"
            >
              <ChevronDown className="size-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setLarge(!large)}
              aria-label={t(large ? "compose.minimize" : "compose.expand")}
              title={t(large ? "compose.minimize" : "compose.expand")}
              className="grid size-8 place-items-center rounded-full hover:bg-white/10"
            >
              {large ? <Minimize2 className="size-4" aria-hidden /> : <Maximize2 className="size-4" aria-hidden />}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={close}
          aria-label={t("compose.close")}
          title={t("compose.close")}
          className="grid size-8 place-items-center rounded-full hover:bg-white/10"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>

      {accounts.length > 1 && (
        <div className="flex h-11 items-center gap-2 border-b border-hairline px-4">
          <label htmlFor="compose-from" className="w-12 shrink-0 text-[13px] font-semibold text-muted">
            {t("compose.from")}
          </label>
          {account && <AccountDot color={account.color} />}
          <select
            id="compose-from"
            value={accountId}
            onChange={(event) => update({ accountId: event.target.value })}
            className="h-9 min-w-0 flex-1 bg-transparent text-[14px] outline-none"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName} &lt;{a.email}&gt;
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="relative">
        <RecipientInput
          label={t("compose.to")}
          value={draft.to}
          onChange={(to) => update({ to })}
          autoFocus={request.mode !== "reply" && request.mode !== "replyAll"}
        />
        {!showCc && (
          <button
            type="button"
            onClick={() => setShowCc(true)}
            className="absolute top-2.5 right-4 rounded-full px-2 py-1 text-[12px] font-semibold text-muted hover:bg-pink-tint hover:text-pink-ink"
          >
            {t("compose.showCcBcc")}
          </button>
        )}
      </div>
      {showCc && (
        <>
          <RecipientInput label={t("compose.cc")} value={draft.cc} onChange={(cc) => update({ cc })} />
          <RecipientInput label={t("compose.bcc")} value={draft.bcc} onChange={(bcc) => update({ bcc })} />
        </>
      )}
      <div className="flex h-11 items-center gap-2 border-b border-hairline px-4">
        <label htmlFor="compose-subject" className="w-12 shrink-0 text-[13px] font-semibold text-muted">
          {t("compose.subject")}
        </label>
        <input
          id="compose-subject"
          value={draft.subject}
          onChange={(event) => update({ subject: event.target.value })}
          className="h-9 min-w-0 flex-1 bg-transparent text-[14px] font-semibold outline-none"
        />
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div
          ref={(node) => {
            editor.current = node;
            if (node && node.innerHTML === "") node.innerHTML = body.current;
          }}
          contentEditable
          role="textbox"
          aria-multiline
          aria-label={t("compose.placeholder")}
          data-placeholder={t("compose.placeholder")}
          onInput={(event) => {
            setError(null);
            changed();
            body.current = event.currentTarget.innerHTML;
            setEdits((count) => count + 1);
          }}
          className="min-h-full px-5 py-4 text-[14.5px] leading-relaxed outline-none empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)] [&_a]:text-pink-ink [&_a]:underline [&_blockquote]:my-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-pink-tint-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_p]:min-h-[1.4em] [&_ul]:list-disc [&_ul]:pl-6"
        />
      </div>

      {attachments.length > 0 && (
        <ul className="flex flex-wrap gap-2 border-t border-hairline px-4 py-2">
          {attachments.map((attachment, index) => (
            <li
              key={`${attachment.filename}-${index}`}
              className="flex h-8 items-center gap-2 rounded-full bg-canvas pr-1 pl-3 text-[12.5px]"
            >
              <Paperclip className="size-3.5 text-muted" aria-hidden />
              <span className="max-w-[180px] truncate font-semibold">{attachment.filename}</span>
              <span className="text-muted">{formatSize(attachment.size, i18n.language)}</span>
              <button
                type="button"
                aria-label={t("compose.removeAttachment", { name: attachment.filename })}
                onClick={() => {
                  changed();
                  setAttachments(attachments.filter((_, i) => i !== index));
                }}
                className="grid size-6 place-items-center rounded-full hover:bg-pink-tint"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="mx-4 mb-2 rounded-xl bg-danger-tint px-3 py-2 text-[13px] font-medium text-danger">
          {error}
        </p>
      )}

      <footer className="flex items-center gap-1 border-t border-hairline px-3 py-2.5">
        <Button
          variant="primary"
          icon={Send}
          busy={sending}
          onClick={() => void send()}
          title={`${t("compose.send")} (${modKey}+Enter)`}
        >
          {sending ? t("compose.sending") : t("compose.send")}
        </Button>
        <span className="mx-1.5 h-5 w-px bg-line" aria-hidden />
        <IconButton
          icon={Bold}
          size="sm"
          label={t("compose.bold")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format("bold")}
        />
        <IconButton
          icon={Italic}
          size="sm"
          label={t("compose.italic")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format("italic")}
        />
        <IconButton
          icon={List}
          size="sm"
          label={t("compose.list")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format("insertUnorderedList")}
        />
        <IconButton
          icon={Link}
          size="sm"
          label={t("compose.link")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => format("createLink")}
        />
        <IconButton icon={Paperclip} size="sm" label={t("compose.attach")} onClick={() => fileInput.current?.click()} />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={async (event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = "";
            const added = await Promise.all(
              files.map(async (file) => ({
                filename: file.name,
                mimeType: file.type || "application/octet-stream",
                size: file.size,
                source: { kind: "base64" as const, data: await readAsBase64(file) },
              })),
            );
            changed();
            setAttachments((current) => [...current, ...added]);
          }}
        />
        <span className="flex-1" />
        <DraftStatus state={saveState} />
        <IconButton icon={Trash} size="sm" label={t("compose.discard")} onClick={discard} />
      </footer>
    </section>
  );
}

function DraftStatus({ state }: { state: SaveState }) {
  const { t, i18n } = useT();
  if (state.kind === "idle") return null;
  const text =
    state.kind === "saving"
      ? t("compose.draftSaving")
      : state.kind === "local"
        ? t("compose.draftLocal")
        : t("compose.draftSaved", {
            time: new Date(state.at).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" }),
          });
  return (
    <span
      role="status"
      className={clsx(
        "mr-1 flex min-w-0 items-center gap-1 text-[12px]",
        state.kind === "local" ? "font-semibold text-danger" : "text-muted",
      )}
    >
      {state.kind === "saved" && <Check className="size-3.5 shrink-0" aria-hidden />}
      <span className="truncate">{text}</span>
    </span>
  );
}
