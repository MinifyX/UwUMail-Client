import "@/test/dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@/backend/types";
import { buildDocument, buildPrintDocument, frameStrayed, MAIL_FRAME_SANDBOX, MessageBody } from "./MessageBody";

// WebKit (macOS, iOS, Linux) never calls the app's listeners in a frame without allow-scripts, so
// links in mails opened inside the frame past the link question. These pin what keeps the mail
// from running code once the frame allows scripts.

function message(patch: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "t1",
    accountId: "a1",
    folderId: "f1",
    from: { email: "news@shop.example" },
    to: [],
    cc: [],
    replyTo: [],
    subject: "News",
    date: "2026-09-14T10:00:00Z",
    flags: { seen: false, flagged: false, answered: false, draft: false },
    snippet: "",
    bodyHtml: null,
    bodyText: null,
    hasRemoteContent: false,
    attachments: [],
    ...patch,
  };
}

/** Bodies that try to get something into the head before the policy, or past it. */
const HOSTILE = [
  "<p>Hi</p>",
  '</style></head><head><meta http-equiv="Content-Security-Policy" content="script-src *"><script>steal()</script>',
  '<meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'"><img src=x onerror=steal()>',
  "<!--</head>--><base href=https://elsewhere.example/><svg><script>steal()</script></svg>",
  '<noscript><p title="</noscript><img src=x onerror=steal()>"></noscript>',
  '<a href="javascript:steal()">x</a><iframe srcdoc="<script>steal()</script>"></iframe>',
];

const POLICY_FIRST =
  /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';/;

/** No element that runs or loads code, and no attribute that would. */
function expectNothingRuns(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  expect(doc.querySelectorAll("script, iframe, base, object, embed, noscript")).toHaveLength(0);
  for (const element of doc.querySelectorAll("*")) {
    for (const name of element.getAttributeNames()) {
      expect(name).not.toMatch(/^on/i);
      expect(element.getAttribute(name)).not.toMatch(/^\s*javascript:/i);
    }
  }
}

function headOf(html: string) {
  return new DOMParser().parseFromString(html, "text/html").head;
}

describe("the mail frame", () => {
  afterEach(cleanup);

  it("allows scripts for the app's listeners, and nothing else beyond its own origin", () => {
    expect(MAIL_FRAME_SANDBOX.split(" ").sort()).toEqual(["allow-same-origin", "allow-scripts"]);
    const { container } = render(
      <MessageBody
        message={message({ bodyHtml: "<p>Hi</p>" })}
        allowRemote={false}
        appearance={{ kind: "light", why: "app" }}
      />,
    );
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe(MAIL_FRAME_SANDBOX);
  });

  for (const variant of ["light", "dark"] as const) {
    it(`starts every ${variant} document with a policy that runs no script`, () => {
      for (const body of HOSTILE) {
        for (const kind of ["html", "text"] as const) {
          const doc = buildDocument(message(kind === "html" ? { bodyHtml: body } : { bodyText: body }), true, variant);
          expect(doc).toMatch(POLICY_FIRST);
          const head = headOf(doc);
          const first = head.firstElementChild!;
          expect(first.getAttribute("http-equiv")).toBe("Content-Security-Policy");
          expect(first.getAttribute("content")).toMatch(/^default-src 'none';/);
          expect(first.getAttribute("content")).not.toContain("script-src");
          // Only the reader's own policy, charset and style: nothing from the mail reached the head.
          expect([...head.children].map((element) => element.tagName)).toEqual(["META", "META", "STYLE"]);
          expectNothingRuns(doc);
        }
      }
    });
  }

  it("starts the print document with the same kind of policy", () => {
    for (const body of HOSTILE) {
      const doc = buildPrintDocument(
        message({ bodyHtml: body, subject: "</title><script>steal()</script>" }),
        true,
        new Map(),
        { from: "Von", to: "An", cc: "Cc", date: "Datum" },
        "14. September 2026",
      );
      expect(doc).toMatch(POLICY_FIRST);
      expect(headOf(doc).firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
      expectNothingRuns(doc);
    }
  });

  it("knows when the frame shows something else than its mail", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    // jsdom's fresh frame is about:blank, where every frame starts out.
    expect(frameStrayed(frame)).toBe(false);
    Object.defineProperty(frame, "contentDocument", { value: null });
    expect(frameStrayed(frame)).toBe(true);
    frame.remove();
  });
});
