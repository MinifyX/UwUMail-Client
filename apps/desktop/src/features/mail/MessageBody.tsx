import DOMPurify from "dompurify";
import { useCallback, useMemo, useRef, useState } from "react";
import type { Message } from "@/backend/types";
import { textToHtml } from "@/lib/format";
import { openExternal } from "@/lib/platform";

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

export function buildDocument(message: Message, allowRemote: boolean, dark: boolean) {
  const isHtml = message.bodyHtml !== null;
  const body = isHtml ? sanitize(message.bodyHtml!) : linkify(textToHtml(message.bodyText ?? ""));
  const imageSources = allowRemote ? "data: cid: blob: https: http:" : "data: cid: blob:";
  const csp = `default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:; media-src data:`;
  // The frame never scrolls itself (the reader around it does), so html/body
  // must not stretch to the frame height. Otherwise measuring and resizing
  // would feed each other.
  const frame = `html,body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;overflow:hidden!important}
#${ROOT_ID}{display:flow-root;overflow-x:auto}`;
  // HTML mail brings its own design: keep the sender's typography and only
  // give it white paper (also in dark mode) and some breathing room.
  const html = `body{background:#ffffff;color:#1c1420}
#${ROOT_ID}{padding:16px}
a{color:#c8165f}`;
  const text = `body{color:${dark ? "#f8f2f6" : "#1c1420"};background:transparent;font:15px/1.6 "Manrope Variable",ui-sans-serif,system-ui,sans-serif}
#${ROOT_ID}{overflow-wrap:break-word}
a{color:${dark ? "#ff9dbf" : "#c8165f"}}
p{margin:0 0 12px}
blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #ffd0e2;color:#716672}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${frame}
${isHtml ? html : text}</style></head><body><div id="${ROOT_ID}">${body}</div></body></html>`;
}

interface MessageBodyProps {
  message: Message;
  allowRemote: boolean;
  dark: boolean;
}

export function MessageBody({ message, allowRemote, dark }: MessageBodyProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  const html = useMemo(() => buildDocument(message, allowRemote, dark), [message, allowRemote, dark]);

  const attach = useCallback(() => {
    const doc = frame.current?.contentDocument;
    const root = doc?.getElementById(ROOT_ID);
    if (!doc || !root) return;
    let pending = 0;
    // Measure the content wrapper, not the document: the document is never
    // smaller than the frame, so it would only ever grow. Updates wait for the
    // next frame, which also avoids ResizeObserver loop errors.
    const measure = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const next = Math.max(Math.ceil(root.getBoundingClientRect().height), 24);
        setHeight((current) => (Math.abs(current - next) > 1 ? next : current));
      });
    };
    measure();
    new ResizeObserver(measure).observe(root);
    // Images load after the document; their size changes the height too.
    doc.addEventListener("load", measure, true);
    doc.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      if (/^(https?:|mailto:)/i.test(href)) void openExternal(href);
    });
  }, []);

  return (
    <iframe
      ref={frame}
      title={message.subject}
      // No allow-scripts: mail content can never run code. allow-same-origin only
      // lets the app measure the height and intercept link clicks.
      sandbox="allow-same-origin"
      srcDoc={html}
      onLoad={attach}
      style={{ height }}
      className="block w-full rounded-2xl border-0"
    />
  );
}
