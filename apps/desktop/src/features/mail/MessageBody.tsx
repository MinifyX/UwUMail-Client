import DOMPurify from "dompurify";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ImageSizeProbe, Message } from "@/backend/types";
import { useT } from "@/i18n";
import { markMail, type Mark } from "@/lib/dates";
import type { FontChoice, SenderFonts } from "@/lib/fonts";
import { escapeHtml, textToHtml } from "@/lib/format";
import { replaceContentIds } from "@/lib/inlineImages";
import { fontVariables, rewriteElementFonts } from "@/lib/mailFonts";
import { proxyRemoteImages, type ImageProxy } from "@/lib/remoteImages";
import { SAFE_LINK_MARKER, unwrapSafeLink, unwrapSafeLinkElement, unwrappedText } from "@/lib/safeLinks";
import type { MailAppearance } from "@/state/settings";
import { hideLinkStatus, keepFrameOnMail, watchLinks } from "./linkEvents";
import { darkenImages, type RemoteImageLoader } from "./darkImages";
import { darkenDocument, decide, declaresDarkMode, forceColorSchemeQueries, measure } from "./darkMode";
import { forwardFrameKeys } from "./readerKeys";
import { useMailFonts } from "./useMailFonts";
import { DATE_STYLE, watchDates, type DateReport } from "../dates/frameDates";
import { deferRemotePictures, loadRemotePictures, PICTURE_STYLES, type PictureProgress } from "./remotePictures";

const URL_PATTERN = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"'\]]/g;

/** Web addresses in escaped plain text as links; a Microsoft Safe Link shows and links its original address. */
function linkify(html: string) {
  return html.replace(URL_PATTERN, (escaped) => {
    const safe = unwrapSafeLink(unescapeHtml(escaped));
    if (!safe) return `<a href="${escaped}">${escaped}</a>`;
    const original = escapeHtml(safe.url);
    return `<a href="${original}" ${SAFE_LINK_MARKER}="${escapeHtml(safe.wrapper)}">${original}</a>`;
  });
}

function unescapeHtml(text: string) {
  return text.replace(/&(amp|lt|gt|quot);/g, (_, name: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[name]!);
}

/** A link whose whole text is a Microsoft Safe Link (whatever it points to) reads as the address it wraps. */
function unwrapLinkText(node: Element) {
  if (node.tagName !== "A" || node.children.length > 0) return;
  const original = unwrappedText(node.textContent ?? "");
  if (original !== null) node.textContent = original;
}

const MATHML = "http://www.w3.org/1998/Math/MathML";

/**
 * WebKit (macOS, iOS, Linux) follows `href` on any MathML element, past the reader's link question
 * (which catches `a` and `area`) and into the frame itself. Formulas stay, as text.
 */
function dropMathLinks(node: Element) {
  if (node.namespaceURI !== MATHML) return;
  node.removeAttribute("href");
  node.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
}

/** `data-uwu-*` marks mean something to the reader (dates, pictures); a mail doesn't get to set them. */
function dropOwnMarkers(node: Element) {
  for (const name of node.getAttributeNames()) {
    if (name.toLowerCase().startsWith("data-uwu-")) node.removeAttribute(name);
  }
}

/** Link attributes that would point into the mail's own parts or the app's own files. */
const LINK_ATTRIBUTES = ["href", "xlink:href", "action", "formaction", "data"];
const OWN_FILES = /^(cid|blob):/i;

/**
 * Links may not lead to the mail's embedded parts (`cid:`) or the app's own files (`blob:`): those
 * have the app's origin, and the mail frame may run scripts (security review 0.10 RD-1). Pictures
 * keep their `cid:` sources (see lib/inlineImages).
 */
function dropOwnFileLinks(node: Element) {
  for (const name of LINK_ATTRIBUTES) {
    const value = node.getAttribute(name);
    // Browsers skip leading whitespace and controls and ignore tabs and newlines in a scheme.
    if (value === null) continue;
    const scheme = [...value].filter((char) => char.charCodeAt(0) > 0x20).join("");
    if (OWN_FILES.test(scheme)) node.removeAttribute(name);
  }
}

/**
 * The engine already sanitizes HTML. We sanitize again here because the demo
 * backend and future addons can also produce message bodies. `alsoForbid` drops more elements with
 * their content.
 */
function sanitize(html: string, alsoForbid: string[] = []) {
  const purify = DOMPurify();
  purify.addHook("afterSanitizeAttributes", (node) => {
    // The mail's own markers go first, so only the reader sets the Safe Link one.
    dropOwnMarkers(node);
    dropOwnFileLinks(node);
    // Microsoft Safe Links show and open their original address (lib/safeLinks).
    if (node.tagName === "A" || node.tagName === "AREA") unwrapSafeLinkElement(node);
    unwrapLinkText(node);
    dropMathLinks(node);
    // Same output whatever the font settings say; the frame decides (see lib/mailFonts).
    rewriteElementFonts(node);
  });
  return purify.sanitize(html, {
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
      ...alsoForbid,
    ],
    FORBID_ATTR: ["srcdoc", "formaction", "ping"],
    // Without this, a leading <style> (the first thing in most newsletters) is
    // parsed into <head> and silently dropped.
    FORCE_BODY: true,
  });
}

export const ROOT_ID = "uwu-mail-root";

/**
 * The sandbox of every frame that shows a mail. `allow-same-origin` lets the app measure the
 * height, recolor for dark mode and read the document. `allow-scripts` is there for WebKit (macOS,
 * iOS, Linux): in a frame without it, WebKit never calls the listeners the app puts on the mail's
 * document, so a click on a link went past the link question and opened the page inside the
 * frame, and dates and shortcuts did nothing either. The mail itself still runs nothing: the
 * sanitizer drops scripts and event attributes, the document's own policy (`default-src 'none'`,
 * the first thing in its head) blocks whatever would be left, and the app's policy applies on top.
 */
export const MAIL_FRAME_SANDBOX = "allow-same-origin allow-scripts";

/** Whether a mail frame shows something else than its mail, e.g. a page a link opened in it. */
export function frameStrayed(frame: HTMLIFrameElement): boolean {
  const doc = frame.contentDocument;
  // Another origin's page can't be read at all; about:blank is where a frame starts out.
  return !doc || (doc.URL !== "about:srcdoc" && doc.URL !== "about:blank");
}

/** How often a frame is put back on its mail before the reader gives up (a page fighting back). */
const MAX_RETURNS = 3;

const readable = new WeakMap<Message, string>();

/**
 * The mail's body as the reader shows it, before pictures and colors: sanitized HTML, or the plain
 * text as paragraphs with its web addresses as links. The date finder reads this very markup, so
 * the places it reports fit when they are marked in it (see lib/dates).
 */
export function readableBody(message: Message): string {
  let html = readable.get(message);
  if (html === undefined) {
    html = message.bodyHtml !== null ? sanitize(message.bodyHtml) : linkify(textToHtml(message.bodyText ?? ""));
    readable.set(message, html);
  }
  return html;
}

/** The frame height UwUMail pretends to have when a mail sizes things by the viewport. */
const NOMINAL_VIEWPORT_HEIGHT = 900;

/**
 * A number with a height-based viewport unit. A match only starts where no number goes on before
 * it, and a number can be split one way only, so a long run of digits costs linear time instead of
 * freezing the tab (security-audit WM-1).
 */
const VIEWPORT_HEIGHT = /(?<![\d.])(-?(?:\d+(?:\.\d+)?|\.\d+))(dvh|svh|lvh|vh|vmin|vmax)\b/gi;

/**
 * The frame is always as tall as the mail, so `100vh` inside it means "as tall
 * as myself" and grows forever. Height-based viewport units become fixed pixels.
 */
export function fixViewportHeightUnits(html: string): string {
  return html.replace(VIEWPORT_HEIGHT, (_, amount: string) => {
    const pixels = (parseFloat(amount) * NOMINAL_VIEWPORT_HEIGHT) / 100;
    return `${Math.round(pixels * 100) / 100}px`;
  });
}

/** The font the frame uses, and what becomes of the sender's fonts (see lib/mailFonts). */
export interface MailFonts {
  font: FontChoice;
  senderFonts: SenderFonts;
  /** The chosen font's `data:` @font-face rules; "" while it loads (the system font shows meanwhile). */
  faces: string;
}

const SYSTEM_FONTS: MailFonts = { font: "system", senderFonts: "replace", faces: "" };

/** Where the app hands out remote pictures (`uwuimg:`), on every platform's spelling of it. */
const PROXIED_SOURCES = " uwuimg: http://uwuimg.localhost";

/**
 * The sanitized mail with its remote pictures sent through the app when they may load, and the image
 * sources the frame's CSP allows for that. Without a proxy (the demo) they load directly.
 */
function withRemoteImages(html: string, allowRemote: boolean, imageProxy: ImageProxy | null | undefined) {
  if (!allowRemote) return { html, remote: "" };
  if (imageProxy) return { html: proxyRemoteImages(html, imageProxy), remote: PROXIED_SOURCES };
  return { html, remote: " https: http:" };
}

/**
 * `dark` for plain text means app colors; for HTML it means the mail's own
 * dark mode styles (only used when the mail declares them). With `deferPictures`,
 * allowed remote `<img>`s start out as placeholders for `loadRemotePictures`.
 */
export function buildDocument(
  message: Message,
  allowRemote: boolean,
  variant: "light" | "dark",
  inlineImages: ReadonlyMap<string, string> = new Map(),
  imageProxy?: ImageProxy | null,
  dateMarks: readonly Mark[] = [],
  deferPictures = false,
  fonts: MailFonts = SYSTEM_FONTS,
) {
  const isHtml = message.bodyHtml !== null;
  const dark = variant === "dark";
  const defer = isHtml && allowRemote && deferPictures;
  // Found dates are wrapped first, in the same markup they were found in.
  const marked =
    dateMarks.length > 0 ? markMail(readableBody(message), message.subject, dateMarks) : readableBody(message);
  const sanitized = isHtml ? marked : "";
  const pictures = withRemoteImages(
    defer ? deferRemotePictures(sanitized, imageProxy) : sanitized,
    allowRemote,
    imageProxy,
  );
  const body = isHtml
    ? fixViewportHeightUnits(
        // cid: links survive the sanitizer, our own blob URLs wouldn't: swap them afterwards.
        forceColorSchemeQueries(replaceContentIds(pictures.html, inlineImages), dark),
      )
    : marked;
  const imageSources = `data: cid: blob:${pictures.remote}`;
  const csp = `default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:; media-src data:`;
  // The frame never scrolls itself (the reader around it does), so html/body
  // must not stretch to the frame height. Otherwise measuring and resizing
  // would feed each other. The color-scheme must match the frame element's,
  // or the engine paints an opaque white canvas behind dark content.
  // A font that is still loading leaves --uwu-font on the system font rather than on nothing.
  const variables = fontVariables(fonts.faces || fonts.font === "system" ? fonts.font : "system", fonts.senderFonts);
  const frame = `${fonts.faces ? `${fonts.faces}\n` : ""}:root{color-scheme:${dark ? "dark" : "light"};${variables}}
html,body{margin:0!important;padding:0!important;height:auto!important;min-height:0!important;overflow:hidden!important}
#${ROOT_ID}{display:flow-root;overflow-x:auto}${dateMarks.length > 0 ? `\n${DATE_STYLE}` : ""}`;
  // HTML mail brings its own design: keep the sender's sizes and weights and only give it paper,
  // some breathing room and a font where it names none (the engine's default would be Times).
  const html = `body{background:${dark ? "#1c171f" : "#ffffff"};color:${dark ? "#f8f2f6" : "#1c1420"};font-family:var(--uwu-font)}
#${ROOT_ID}{padding:16px}
a{color:${dark ? "#ff9dbf" : "#c8165f"}}`;
  const text = `body{color:${dark ? "#f8f2f6" : "#1c1420"};background:${dark ? "transparent" : "#ffffff"};font:15px/1.6 var(--uwu-font)}
#${ROOT_ID}{overflow-wrap:break-word;${dark ? "" : "padding:16px"}}
a{color:${dark ? "#ff9dbf" : "#c8165f"}}
p{margin:0 0 12px}
blockquote{margin:8px 0;padding-left:12px;border-left:3px solid ${dark ? "#4d2338" : "#ffd0e2"};color:${dark ? "#b3a8b3" : "#716672"}}`;
  // The policy comes first, before anything else in the document: the frame may run scripts (see
  // MessageBody), so this is what keeps the mail from running any of its own.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta charset="utf-8">
<style>${frame}
${isHtml ? html : text}${defer ? `\n${PICTURE_STYLES}` : ""}</style></head><body><div id="${ROOT_ID}">${body}</div></body></html>`;
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
  imageProxy?: ImageProxy | null,
) {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const people = (list: Message["to"]) =>
    escape(list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", "));
  // The mail shares this one document with the app's own trusted header. The sanitizer drops its
  // <style> blocks -- only a selector there can reach the header's h1/table to hide it -- and the
  // body sits in its own stacking/paint box so an absolutely-positioned element cannot overlay the
  // header above it (webmail security audit W-3). Inline styles, which is what mail uses in practice, are kept.
  const pictures = withRemoteImages(
    message.bodyHtml !== null ? sanitize(message.bodyHtml, ["style"]) : "",
    allowRemote,
    imageProxy,
  );
  const rendered =
    message.bodyHtml !== null
      ? replaceContentIds(pictures.html, inlineImages)
      : `<div style="white-space:pre-wrap">${textToHtml(message.bodyText ?? "")}</div>`;
  const body = `<section style="position:relative;isolation:isolate;contain:content">${rendered}</section>`;
  const imageSources = `data: blob:${pictures.remote}`;
  const rows = [
    [labels.from, people([message.from])],
    [labels.to, people(message.to)],
    ...(message.cc.length > 0 ? [[labels.cc, people(message.cc)]] : []),
    [labels.date, escape(date)],
  ]
    .map(([label, value]) => `<tr><th>${escape(label!)}</th><td>${value}</td></tr>`)
    .join("");
  // The policy first, as in buildDocument: the print frame may run scripts, the mail may not.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src 'unsafe-inline'; font-src data:">
<meta charset="utf-8">
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
  /** Recolor light images while the mail is shown dark. */
  darkImages?: boolean;
  /** Reads remote images for that, where the page itself may not. */
  loadRemoteImage?: RemoteImageLoader;
  /** Sends allowed remote pictures through the app, so their senders never see this device. */
  imageProxy?: ImageProxy | null;
  /** Dates found in the text, underlined and clickable (see features/dates). */
  dateMarks?: readonly Mark[];
  /** A found date was clicked or pressed, or somewhere else in the mail. */
  onDate?: DateReport;
  /** Asks the server for the sizes of remote pictures, so they wait in their place; see remotePictures.ts. */
  imageSizes?: ImageSizeProbe | null;
}

const NO_MARKS: readonly Mark[] = [];

export function MessageBody({
  message,
  allowRemote,
  appearance,
  onAutoDecision,
  inlineImages,
  darkImages = false,
  loadRemoteImage,
  imageProxy,
  dateMarks = NO_MARKS,
  onDate,
  imageSizes = null,
}: MessageBodyProps) {
  const { t } = useT();
  const [height, setHeight] = useState(120);
  const variant = appearance.kind === "dark" ? "dark" : "light";
  const fonts = useMailFonts();
  const html = useMemo(
    () => buildDocument(message, allowRemote, variant, inlineImages, imageProxy, dateMarks, true, fonts),
    [message, allowRemote, variant, inlineImages, imageProxy, dateMarks, fonts],
  );
  // Remount the frame whenever the look changes: recoloring happens in the
  // loaded document, so an unchanged srcdoc alone wouldn't undo it. Embedded
  // images arriving count as a change too.
  const signature = `${message.id}|${appearance.kind}|${allowRemote}|${inlineImages?.size ?? 0}|${darkImages}|${fonts.font}|${fonts.senderFonts}|${fonts.faces.length}`;
  const needsPass = appearance.kind === "auto" || appearance.kind === "darken";
  const [finished, setFinished] = useState<{ signature: string; dark: boolean } | null>(null);
  const done = finished?.signature === signature ? finished : null;
  const onAutoDecisionRef = useRef(onAutoDecision);
  const onDateRef = useRef(onDate);
  useEffect(() => {
    onAutoDecisionRef.current = onAutoDecision;
    onDateRef.current = onDate;
  });
  const [progress, setProgress] = useState<(PictureProgress & { signature: string }) | null>(null);
  // A mail that goes away under the pointer never reports the pointer leaving its link.
  useEffect(() => hideLinkStatus, [signature]);
  /** Stops what the shown document started: picture loading, recoloring, measuring. */
  const teardown = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      teardown.current?.();
      teardown.current = null;
    },
    [signature],
  );
  /** Documents already set up, so the early start and the load event never both do it. */
  const prepared = useRef(new WeakSet<Document>());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const returns = useRef({ signature: "", count: 0 });

  /** The frame loaded something: its mail, to set up, or something else, to replace by the mail. */
  const onLoad = (frame: HTMLIFrameElement) => {
    if (!frameStrayed(frame)) {
      setUp(frame);
      return;
    }
    if (returns.current.signature !== signature) returns.current = { signature, count: 0 };
    if (returns.current.count >= MAX_RETURNS) return;
    returns.current.count += 1;
    // React wouldn't set an unchanged srcdoc again; setting it loads the mail anew.
    frame.srcdoc = html;
  };

  const setUp = (frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument;
    const root = doc?.getElementById(ROOT_ID);
    if (!doc || !root || prepared.current.has(doc)) return;
    prepared.current.add(doc);
    teardown.current?.();
    const stops: (() => void)[] = [];
    teardown.current = () => {
      for (const stop of stops) stop();
    };

    let shownDark = variant === "dark";
    if (needsPass) {
      const dark = appearance.kind === "darken" || decide(measure(root)) === "darken";
      if (dark) darkenDocument(root);
      if (appearance.kind === "auto") onAutoDecisionRef.current?.(dark);
      setFinished({ signature, dark });
      shownDark = dark;
    }
    // Also for mails with their own dark mode: their images are usually still made for white paper.
    if (darkImages && shownDark && message.bodyHtml !== null) {
      stops.push(darkenImages(root, allowRemote ? loadRemoteImage : undefined));
    }
    // After darkenImages, which follows each picture from the moment it gets its real address. Only
    // where remote pictures may load at all: asking for the sizes fetches each address.
    if (allowRemote && message.bodyHtml !== null) {
      stops.push(loadRemotePictures(root, imageSizes, (next) => setProgress({ ...next, signature })));
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
    stops.push(() => {
      observer.disconnect();
      cancelAnimationFrame(pending);
    });
    // Images load after the document; their size changes the height too.
    doc.addEventListener("load", updateHeight, true);
    // Before the shortcuts: Enter and Space on a date are the date's.
    if (dateMarks.length > 0) watchDates(frame, doc, (index, anchor) => onDateRef.current?.(index, anchor));
    // ↑/↓ and the other shortcuts keep working while the focus is inside the mail.
    forwardFrameKeys(frame, doc);
    watchLinks(frame, doc);
    keepFrameOnMail(doc);
  };

  // A srcdoc frame's load event waits for every picture in it, and one dead host held the whole
  // mail back. So the document is set up as soon as it is parsed; the load event stays as a
  // fallback. Always the latest `setUp`, which knows the current look.
  const setUpRef = useRef(setUp);
  useEffect(() => {
    setUpRef.current = setUp;
  });
  useEffect(() => {
    let frame = 0;
    const until = performance.now() + 10_000;
    const check = () => {
      const element = frameRef.current;
      const doc = element?.contentDocument;
      if (
        element &&
        doc &&
        doc.URL === "about:srcdoc" &&
        doc.readyState !== "loading" &&
        doc.getElementById(ROOT_ID) &&
        !prepared.current.has(doc)
      ) {
        setUpRef.current(element);
        return;
      }
      if (performance.now() < until) frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [html, signature]);

  const scheme = variant === "dark" || done?.dark ? "dark" : "light";
  // Hide until recolored, so dark mode never flashes white paper.
  const hidden = needsPass && !done;
  const loading = progress?.signature === signature && progress.done < progress.total ? progress : null;
  const label = loading ? t("reader.remoteProgress", { done: loading.done, total: loading.total }) : "";

  return (
    <div className="relative">
      {loading && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={loading.total}
          aria-valuenow={loading.done}
          aria-valuetext={label}
          aria-label={label}
          // Over the top of the mail rather than above it, so nothing moves when it comes and goes;
          // a moment late, so pictures that come quickly don't flash it.
          className="pointer-events-none absolute inset-x-0 top-0 z-10 animate-fade [animation-delay:300ms] [animation-fill-mode:both]"
        >
          <div className="h-[3px] overflow-hidden rounded-t-2xl bg-pink-tint">
            <div
              className="h-full bg-pink-solid transition-[width] duration-200"
              style={{ width: `${(loading.done / loading.total) * 100}%` }}
            />
          </div>
          <span className="absolute top-2 right-2 rounded-full border border-hairline bg-surface/90 px-2 py-0.5 text-[11.5px] font-semibold text-muted tabular-nums shadow-sm">
            {label}
          </span>
        </div>
      )}
      <iframe
        key={signature}
        ref={frameRef}
        title={message.subject}
        // See MAIL_FRAME_SANDBOX: the app's listeners need allow-scripts in WebKit, the mail's
        // own code is kept out by the sanitizer and the document's policy.
        sandbox={MAIL_FRAME_SANDBOX}
        srcDoc={html}
        onLoad={(event) => onLoad(event.currentTarget)}
        style={{ height, colorScheme: scheme, opacity: hidden ? 0 : 1 }}
        className="block w-full rounded-2xl border-0 transition-opacity duration-150"
      />
    </div>
  );
}
