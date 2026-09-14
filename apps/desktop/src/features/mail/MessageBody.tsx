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
  });
}

function buildDocument(message: Message, allowRemote: boolean, dark: boolean) {
  const isHtml = message.bodyHtml !== null;
  const body = isHtml ? sanitize(message.bodyHtml!) : linkify(textToHtml(message.bodyText ?? ""));
  const imageSources = allowRemote ? "data: cid: blob: https: http:" : "data: cid: blob:";
  const csp = `default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:; media-src data:`;
  // HTML mail is designed for white paper, so it keeps a light background in dark mode.
  const plainColors = dark ? "color:#f8f2f6;background:transparent" : "color:#1c1420;background:transparent";
  const colors = isHtml ? "color:#1c1420;background:#ffffff" : plainColors;
  const link = dark && !isHtml ? "#ff9dbf" : "#c8165f";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
html,body{margin:0;padding:0}
body{${colors};font:15px/1.6 "Manrope Variable",ui-sans-serif,system-ui,sans-serif;overflow-wrap:anywhere;padding:${isHtml ? "20px" : "0"};}
a{color:${link}}
img{max-width:100%;height:auto}
blockquote{margin:8px 0;padding-left:12px;border-left:3px solid #ffd0e2;color:#716672}
pre{white-space:pre-wrap}
p{margin:0 0 12px}
</style></head><body>${body}</body></html>`;
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
    if (!doc) return;
    const measure = () => setHeight(Math.max(doc.documentElement.scrollHeight, 40));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(doc.body);
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
