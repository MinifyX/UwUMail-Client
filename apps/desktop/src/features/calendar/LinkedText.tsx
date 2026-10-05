import { Fragment, type KeyboardEvent, type MouseEvent } from "react";
import { checkLink } from "@/lib/links";
import { requestOpenLink, useLinks } from "@/state/links";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?]/g;

/**
 * A web address in event text, which comes from whoever wrote the event — an invitation from
 * anyone lands in the calendar by itself. It has no `href`, so nothing the browser does with
 * links on its own (middle click, a drag onto the tab bar, the link menu, a long press) can open
 * it past the check (security-audit W-23, WEBMAIL-3). A click, Enter and the middle button ask
 * through the same link check as links in mail; the context menu (a long press, where the
 * browser sends one) opens the link sheet, which shows where it goes before it opens or copies it.
 */
export function CheckedLink({ url }: { url: string }) {
  const open = () => requestOpenLink(url, url);
  const sheet = () => {
    const check = checkLink(url, url);
    if (check) useLinks.setState({ sheet: check, hover: null });
  };
  return (
    <span
      role="link"
      tabIndex={0}
      title={url}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        open();
      }}
      onAuxClick={(event: MouseEvent) => {
        event.preventDefault();
        if (event.button === 1) open();
      }}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        open();
      }}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        sheet();
      }}
      onDragStart={(event) => event.preventDefault()}
      className="cursor-pointer break-all text-pink-ink underline decoration-pink/40 underline-offset-2 hover:decoration-pink focus-visible:rounded-sm focus-visible:shadow-focus focus-visible:outline-none"
    >
      {url}
    </span>
  );
}

/** Plain text with its web addresses clickable, through the same link check as links in mail. */
export function LinkedText({ text }: { text: string }) {
  const parts: { text: string; url: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), url: false });
    parts.push({ text: match[0], url: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), url: false });
  return (
    <>
      {parts.map((part, index) =>
        part.url ? <CheckedLink key={index} url={part.text} /> : <Fragment key={index}>{part.text}</Fragment>,
      )}
    </>
  );
}
