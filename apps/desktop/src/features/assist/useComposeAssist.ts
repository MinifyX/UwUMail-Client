import { type RefObject, useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { escapeHtml } from "@/lib/format";
import { toast } from "@/state/toasts";
import { composeEstimate, type ComposeAssistContext, type ComposeAssistStart } from "./ComposeAssist";
import { appendToOwnText, ownText, replaceOwnText } from "./draftText";
import type { EstimateRequest } from "./estimate";
import { useAssistFeature } from "./useAssist";

/** Writes the editor's content; its own function, as the editor belongs to the composer. */
function setHtml(node: HTMLElement, html: string) {
  node.innerHTML = html;
}

interface ComposeAssistOptions {
  accountId: string;
  editor: RefObject<HTMLDivElement | null>;
  /** The draft's HTML as last saved into state, for when the editor isn't there. */
  body: RefObject<string>;
  subject: string;
  replyToEmailId: string | null;
  /** The draft changed through the assistant: save it and show it. */
  onChanged: (html: string) => void;
}

/**
 * The composer's side of the assistant: what was asked, and where in the draft the answer may
 * go. The answer reaches the draft only through `apply` (Insert or Replace, a click away).
 */
export function useComposeAssist({
  accountId,
  editor,
  body,
  subject,
  replyToEmailId,
  onChanged,
}: ComposeAssistOptions) {
  const { t, i18n } = useT();
  const available = useAssistFeature("compose", accountId);
  const [open, setOpen] = useState<{
    key: number;
    start: ComposeAssistStart;
    context: ComposeAssistContext;
    range: Range | null;
  } | null>(null);
  /** The last cursor or marked text inside the editor, kept while the focus is elsewhere. */
  const lastRange = useRef<Range | null>(null);
  useEffect(() => {
    const remember = () => {
      const selection = window.getSelection();
      if (!selection?.rangeCount || !editor.current) return;
      const range = selection.getRangeAt(0);
      if (editor.current.contains(range.commonAncestorContainer)) lastRange.current = range.cloneRange();
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, [editor]);

  /** A range that still points into the editor as it is now. */
  const liveRange = (range: Range | null) =>
    range && editor.current?.contains(range.startContainer) && editor.current.contains(range.endContainer)
      ? range
      : null;

  /** What the draft gives the assistant now: the marked text, or the person's own part. */
  const contextNow = () => {
    const html = editor.current?.innerHTML ?? body.current;
    const range = liveRange(lastRange.current);
    const marked = range && !range.collapsed ? range.toString().trim() : "";
    const context: ComposeAssistContext = {
      source: marked ? { scope: "selection", text: marked } : { scope: "own", text: ownText(html) },
      subject,
      replyToEmailId,
      language: i18n.language,
    };
    return { context, range };
  };

  const start = (what: ComposeAssistStart) => {
    const { context, range } = contextNow();
    setOpen((current) => ({
      key: (current?.key ?? 0) + 1,
      start: what,
      range: range?.cloneRange() ?? null,
      context,
    }));
  };

  /** The call a menu item would make with the draft as it is now, for its estimate. */
  const estimateFor = (what: ComposeAssistStart): EstimateRequest | null =>
    composeEstimate(accountId, what, contextNow().context);

  /** Puts the assistant's text into the draft, with the editor's undo where it can. */
  const apply = (how: "insert" | "replace", text: string) => {
    const node = editor.current;
    if (!node || !open) return;
    const inline = escapeHtml(text.trim()).replace(/\r?\n/g, "<br>");
    const target = how === "replace" ? liveRange(open.range) : liveRange(lastRange.current);
    const selection = window.getSelection();
    if (how === "replace" && open.context.source.scope === "selection" && target && selection) {
      node.focus();
      selection.removeAllRanges();
      selection.addRange(target);
      document.execCommand("insertHTML", false, inline);
    } else if (how === "replace") {
      setHtml(node, replaceOwnText(node.innerHTML, text));
    } else if (target && selection) {
      node.focus();
      selection.removeAllRanges();
      target.collapse(false);
      selection.addRange(target);
      document.execCommand("insertHTML", false, inline);
    } else {
      setHtml(node, appendToOwnText(node.innerHTML, text));
    }
    onChanged(node.innerHTML);
    setOpen(null);
    toast(t("assist.compose.applied"), "success");
  };

  return { available, open, start, estimateFor, apply, close: () => setOpen(null) };
}
