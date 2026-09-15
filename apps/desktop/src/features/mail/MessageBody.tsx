import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Message } from "@/backend/types";
import { textToHtml } from "@/lib/format";
import { replaceContentIds } from "@/lib/inlineImages";
import { requestOpenLink } from "@/state/links";
import type { MailAppearance } from "@/state/settings";
import { darkenDocument, decide, declaresDarkMode, forceColorSchemeQueries, measure } from "./darkMode";

const URL_PATTERN = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"'\]]/g;

function linkify(html: string) {
  return html.replace(URL_PATTERN, (url) => `<a href="${url}">${url}</a>`);
}

/**
 * The engine already sanitizes HTML. We sanitize again here because the demo
 * backend and future addons can also produce message bodies.
 */
function sanitize(html: string) {
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "meta",
      "link",
      "base",
    ],
    FORBID_ATTR: ["srcdoc", "formaction", "ping"],
    // Without this, a leading <style> (the first thing in most newsletters) is
    // parsed into <head> and silently dropped.
    FORCE_BODY: true,
  });
}

export const ROOT_ID = "uwu-mail-root";

/** The frame height UwUMail pretends to have when a mail sizes things by the viewport. */
const NOMINAL_VIEWPORT_HEIGHT = 900;

/**
 * The frame is always as tall as the mail, so `100vh` inside it means "as tall
 * as myself" and grows forever. Height-based viewport units become fixed pixels.
 */
export function fixViewportHeightUnits(html: string): string {
  return html.replace(/(-?\d*\.?\d+)(dvh|svh|lvh|vh|vmin|vmax)\b/gi, (_, amount: string) => {
    const pixels = (parseFloat(amount) * NOMINAL_VIEWPORT_HEIGHT) / 100;
    return `${Math.round(pixels * 100) / 100}px`;
  });
}

/**
 * `dark` for plain text means app colors; for HTML it means the mail's own
 * dark mode styles (only used when the mail declares them).
 */
export function buildDocument(
  message: Message,
  allowRemote: boolean,
  variant: "light" | "dark",
  inlineImages: ReadonlyMap<string, string> = new Map(),
) {
  const isHtml = message.bodyHtml !== null;
  const dark = variant === "dark";
  const body = isHtml
    ? fixViewportHeightUnits(
        // cid: links survive the sanitizer, our own blob URLs wouldn't: swap them afterwards.
        forceColorSchemeQueries(replaceContentIds(sanitize(message.bodyHtml!), inlineImages), dark),
      )
    : linkify(textToHtml(message.bodyText ?? ""));
  const imageSources = allowRemote ? "data: cid: blob: https: http:" : "data: cid: blob:";
  const csp = `default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:; media-src data:`;
  // The frame never scrolls itself (the reader around it does), so html/body
  // must not stretch to the frame height. Otherwise measuring and resizing
  // would feed each other. The color-scheme must match the frame element's,
  // or the engine paints an opaque white canvas behind dark content.
  const frame = `:root{color-scheme:${dark ? "dark" : "light"}}
html,body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;overflow:hidden!important}
#${ROOT_ID}{display:flow-root;overflow-x:auto}`;
  // HTML mail brings its own design: keep the sender's typography and only
  // give it paper and some breathing room.
  const html = `body{background:${dark ? "#1c171f" : "#ffffff"};color:${dark ? "#f8f2f6" : "#1c1420"}}
#${ROOT_ID}{padding:16px}
a{color:${dark ? "#ff9dbf" : "#c8165f"}}`;
  const text = `body{color:${dark ? "#f8f2f6" : "#1c1420"};background:${dark ? "transparent" : "#ffffff"};font:15px/1.6 "Manrope Variable",ui-sans-serif,system-ui,sans-serif}
#${ROOT_ID}{overflow-wrap:break-word;${dark ? "" : "padding:16px"}}
a{color:${dark ? "#ff9dbf" : "#c8165f"}}
p{margin:0 0 12px}
blockquote{margin:8px 0;padding-left:12px;border-left:3px solid ${dark ? "#4d2338" : "#ffd0e2"};color:${dark ? "#b3a8b3" : "#716672"}}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${frame}
${isHtml ? html : text}</style></head><body><div id="${ROOT_ID}">${body}</div></body></html>`;
}

export interface PrintLabels {
  from: string;
  to: string;
  cc: string;
  date: string;
}

/**
 * A page for printing one mail: its header and the body, sanitized like in the reader, light,
 * without remote content unless it's allowed for this mail.
 */
export function buildPrintDocument(
  message: Message,
  allowRemote: boolean,
  inlineImages: ReadonlyMap<string, string>,
  labels: PrintLabels,
  date: string,
) {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const people = (list: Message["to"]) =>
    escape(list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", "));
  const body =
    message.bodyHtml !== null
      ? replaceContentIds(sanitize(message.bodyHtml), inlineImages)
      : `<div style="white-space:pre-wrap">${textToHtml(message.bodyText ?? "")}</div>`;
  const imageSources = allowRemote ? "data: blob: https: http:" : "data: blob:";
  const rows = [
    [labels.from, people([message.from])],
    [labels.to, people(message.to)],
    ...(message.cc.length > 0 ? [[labels.cc, people(message.cc)]] : []),
    [labels.date, escape(date)],
  ]
    .map(([label, value]) => `<tr><th>${escape(label!)}</th><td>${value}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:">
<title>${escape(message.subject)}</title>
<style>@page{margin:16mm}body{margin:0;color:#1c1420;background:#fff;font:14px/1.5 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 8px}table.head{border-collapse:collapse;margin:0 0 12px;font-size:12.5px}
table.head th{text-align:left;color:#716672;font-weight:600;padding:1px 12px 1px 0;vertical-align:top}
hr{border:0;border-top:1px solid #e6dde3;margin:0 0 16px}img{max-width:100%}</style></head>
<body><h1>${escape(message.subject)}</h1><table class="head">${rows}</table><hr>${body}</body></html>`;
}

/**
 * A feedback loop between frame size and layout grows by (almost) the same
 * amount on every frame. Images loading one after another don't look like that.
 * Records the step and reports whether the last ten steps form such a loop.
 */
export function isRunaway(
  history: { time: number; delta: number }[],
  last: number,
  next: number,
  now = performance.now(),
) {
  if (last <= 0 || next <= last) {
    history.length = 0;
    return false;
  }
  const delta = next - last;
  const previous = history[history.length - 1];
  if (previous && (now - previous.time > 120 || Math.abs(previous.delta - delta) > 2)) history.length = 0;
  history.push({ time: now, delta });
  return history.length >= 10;
}

/** What a mail looks like before any measuring. `auto` still needs the rendered mail to decide. */
export type Appearance =
  | { kind: "light"; why: "app" | "choice" }
  | { kind: "dark"; why: "app" | "native" | "choice" }
  | { kind: "darken"; why: "choice" }
  | { kind: "auto" };

export function resolveAppearance(message: Message, appDark: boolean, preference: MailAppearance): Appearance {
  if (!appDark) return { kind: "light", why: "app" };
  if (message.bodyHtml === null) {
    return preference === "light" ? { kind: "light", why: "choice" } : { kind: "dark", why: "app" };
  }
  if (preference === "light") return { kind: "light", why: "choice" };
  if (declaresDarkMode(message.bodyHtml)) return { kind: "dark", why: "native" };
  return preference === "dark" ? { kind: "darken", why: "choice" } : { kind: "auto" };
}

interface MessageBodyProps {
  message: Message;
  allowRemote: boolean;
  appearance: Appearance;
  /** Reports the result of the automatic decision. */
  onAutoDecision?: (dark: boolean) => void;
  /** Blob URLs of embedded images by Content-ID. */
  inlineImages?: ReadonlyMap<string, string>;
}

export function MessageBody({ message, allowRemote, appearance, onAutoDecision, inlineImages }: MessageBodyProps) {
  const [height, setHeight] = useState(120);
  const variant = appearance.kind === "dark" ? "dark" : "light";
  const html = useMemo(
    () => buildDocument(message, allowRemote, variant, inlineImages),
    [message, allowRemote, variant, inlineImages],
  );
  // Remount the frame whenever the look changes: recoloring happens in the
  // loaded document, so an unchanged srcdoc alone wouldn't undo it. Embedded
  // images arriving count as a change too.
  const signature = `${message.id}|${appearance.kind}|${allowRemote}|${inlineImages?.size ?? 0}`;
  const needsPass = appearance.kind === "auto" || appearance.kind === "darken";
  const [finished, setFinished] = useState<{ signature: string; dark: boolean } | null>(null);
  const done = finished?.signature === signature ? finished : null;
  const onAutoDecisionRef = useRef(onAutoDecision);
  useEffect(() => {
    onAutoDecisionRef.current = onAutoDecision;
  });

  const handleLoad = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    const root = doc?.getElementById(ROOT_ID);
    if (!doc || !root) return;

    if (needsPass) {
      const dark = appearance.kind === "darken" || decide(measure(root)) === "darken";
      if (dark) darkenDocument(root);
      if (appearance.kind === "auto") onAutoDecisionRef.current?.(dark);
      setFinished({ signature, dark });
    }

    let pending = 0;
    let last = 0;
    let frozen = false;
    const growth: { time: number; delta: number }[] = [];
    // Measure the content wrapper, not the document: the document is never
    // smaller than the frame, so it would only ever grow. Updates wait for the
    // next frame, which also avoids ResizeObserver loop errors.
    const observer = new ResizeObserver(() => updateHeight());
    const updateHeight = () => {
      if (frozen) return;
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const next = Math.max(Math.ceil(root.getBoundingClientRect().height), 24);
        if (Math.abs(next - last) <= 1) return;
        if (isRunaway(growth, last, next)) {
          // Some layout keeps growing with its own frame. Stop following it
          // rather than stretching the mail forever.
          frozen = true;
          observer.disconnect();
          return;
        }
        last = next;
        setHeight(next);
      });
    };
    updateHeight();
    observer.observe(root);
    // Images load after the document; their size changes the height too.
    doc.addEventListener("load", updateHeight, true);
    doc.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      event.preventDefault();
      requestOpenLink(anchor.getAttribute("href") ?? "", anchor.textContent ?? "");
    });
  };

  const scheme = variant === "dark" || done?.dark ? "dark" : "light";
  // Hide until recolored, so dark mode never flashes white paper.
  const hidden = needsPass && !done;

  return (
    <iframe
      key={signature}
      title={message.subject}
      // No allow-scripts: mail content can never run code. allow-same-origin only
      // lets the app measure the height, recolor for dark mode and intercept links.
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={(event) => handleLoad(event.currentTarget)}
      style={{ height, colorScheme: scheme, opacity: hidden ? 0 : 1 }}
      className="block w-full rounded-2xl border-0 transition-opacity duration-150"
    />
  );
}
