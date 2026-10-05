/**
 * "≈ 1,250 tokens · ≈ 0.02 € (max 0.05 €) · 48,000 left today" on the assistant's buttons, with a
 * small breakdown below: what a call would take, asked
 * for the first time the pointer rests on the button (or a finger holds it), then kept per call
 * and arguments. A UwUMail server answers with `Assist/estimate`; other mailboxes count on this
 * device. An older server, or any error, simply means no tooltip.
 */

import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import type { TFunction } from "i18next";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { backend } from "@/backend/backend";
import type { AssistEstimate, AssistEstimateMethod } from "@/backend/types";
import { useT } from "@/i18n";
import { queryKeys } from "@/lib/queries";
import { formatCost, useAssistCurrency } from "./cost";

/** One call as the estimate needs it: whose assistant, which method and its arguments. */
export interface EstimateRequest {
  accountId: string;
  method: AssistEstimateMethod;
  args: Record<string, unknown>;
}

/** A request, or a way to make it only when the tooltip is wanted (e.g. reading the draft). */
export type EstimateSource = EstimateRequest | null | (() => EstimateRequest | null);

/** How long a finger holds a button before its tooltip shows instead of the tap. */
export const LONG_PRESS_MS = 500;
/** How long a tooltip shown by a long press stays. */
const TOUCH_SHOW_MS = 2500;

/** Arguments with their keys sorted, so the same call is the same cache entry. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

export function estimateKey(request: EstimateRequest, currency = "EUR"): unknown[] {
  return [
    ...queryKeys.assistEstimate,
    request.accountId,
    request.method,
    JSON.stringify(stable(request.args)),
    currency,
  ];
}

/** A count as rough as the estimate is: exact below 100 (at least 1), to tens below 1,000, to hundreds above. */
export function roughly(tokens: number): number {
  if (tokens < 100) return Math.max(1, Math.round(tokens));
  return tokens < 1000 ? Math.round(tokens / 10) * 10 : Math.round(tokens / 100) * 100;
}

/**
 * The tooltip's text: "≈ 1,250 tokens · ≈ 0.02 € (max 0.05 €) · 48,000 left today", the cost (and
 * its worst case) where it is known, what is left where the provider has a limit.
 */
export function estimateText(estimate: AssistEstimate, t: TFunction, locale: string): string {
  const number = new Intl.NumberFormat(locale);
  const total = roughly(estimate.totalTokens);
  const parts = [t("assist.estimate.tokens", { count: total, formatted: number.format(total) })];
  // A server from before prices has no cost, and one whose admin keeps them to themselves says null.
  const cost = estimate.cost;
  if (cost) {
    const about = formatCost(cost, locale, t, true);
    const max = cost.max;
    parts.push(
      max && max.amount > cost.amount
        ? t("assist.estimate.withMax", {
            cost: about,
            max: formatCost({ amount: max.amount, currency: cost.currency }, locale, t),
          })
        : about,
    );
  }
  if (estimate.tokensLeftToday !== null) {
    parts.push(t("assist.estimate.tokensLeft", { formatted: number.format(estimate.tokensLeftToday) }));
  } else if (estimate.requestsLeftToday !== null) {
    parts.push(
      t("assist.estimate.requestsLeft", {
        count: estimate.requestsLeftToday,
        formatted: number.format(estimate.requestsLeftToday),
      }),
    );
  }
  return parts.join(" · ");
}

/** One line of the breakdown: "Input" and "≈ 900 tokens · ≈ €0.004". */
export interface BreakdownLine {
  key: "input" | "pictures" | "answer" | "thinking" | "extraCalls" | "fees";
  label: string;
  value: string;
}

/** Purposes of extra calls the texts know; others read as "other". */
const PURPOSES = ["pictures", "chunk", "retry", "refine"];

/**
 * The small breakdown under the estimate (as in the webmail): input, pictures, answer, thinking,
 * the extra calls by what they are for, and fees, only the parts that aren't zero. Empty for an
 * older server, which says none of it. Whether recent calls corrected it is `estimate.calibrated`.
 */
export function estimateBreakdown(estimate: AssistEstimate, t: TFunction, locale: string): BreakdownLine[] {
  const parts = estimate.cost?.parts ?? null;
  if (estimate.calls.length === 0 && !parts) return [];
  const number = new Intl.NumberFormat(locale);
  const currency = estimate.cost?.currency ?? "EUR";
  const tokens = (count: number) => {
    const rough = roughly(count);
    return t("assist.estimate.tokens", { count: rough, formatted: number.format(rough) });
  };
  const money = (amount: number | undefined) =>
    amount && amount > 0 ? formatCost({ amount, currency }, locale, t, true) : null;
  const join = (...values: (string | null)[]) => values.filter(Boolean).join(" · ");
  const label = (key: BreakdownLine["key"]) => t(`assist.estimate.part.${key}`);
  const lines: BreakdownLine[] = [];
  if (estimate.inputTokens > 0 || money(parts?.input)) {
    lines.push({ key: "input", label: label("input"), value: join(tokens(estimate.inputTokens), money(parts?.input)) });
  }
  if (estimate.imageCount > 0 || money(parts?.images)) {
    lines.push({
      key: "pictures",
      label: label("pictures"),
      value: join(
        estimate.imageCount > 0
          ? t("assist.estimate.pictures", { count: estimate.imageCount, formatted: number.format(estimate.imageCount) })
          : null,
        money(parts?.images),
      ),
    });
  }
  if (estimate.outputTokens > 0 || money(parts?.output)) {
    lines.push({
      key: "answer",
      label: label("answer"),
      value: join(tokens(estimate.outputTokens), money(parts?.output)),
    });
  }
  if (estimate.reasoningTokens > 0 || money(parts?.reasoning)) {
    lines.push({
      key: "thinking",
      label: label("thinking"),
      value: join(estimate.reasoningTokens > 0 ? tokens(estimate.reasoningTokens) : null, money(parts?.reasoning)),
    });
  }
  // Extra calls by purpose, in the order they come: "4 × reading pictures, retry (sometimes)".
  const extra = new Map<string, { count: number; sometimes: boolean }>();
  for (const call of estimate.calls) {
    if (call.purpose === "main" || call.weight <= 0) continue;
    const purpose = PURPOSES.includes(call.purpose) ? call.purpose : "other";
    const entry = extra.get(purpose) ?? { count: 0, sometimes: true };
    entry.count += 1;
    entry.sometimes &&= call.weight < 1;
    extra.set(purpose, entry);
  }
  if (extra.size > 0) {
    const what = [...extra].map(([purpose, { count, sometimes }]) => {
      const name = t(`assist.estimate.purpose.${purpose}`);
      const counted = count > 1 ? t("assist.estimate.times", { count, what: name }) : name;
      return sometimes ? t("assist.estimate.sometimes", { what: counted }) : counted;
    });
    lines.push({ key: "extraCalls", label: label("extraCalls"), value: what.join(", ") });
  }
  const fees = money((parts?.requests ?? 0) + (parts?.other ?? 0));
  if (fees) lines.push({ key: "fees", label: label("fees"), value: fees });
  return lines;
}

/** The estimate of one call, asked for only once `wanted`. */
export function useAssistEstimate(request: EstimateRequest | null, wanted: boolean) {
  const currency = useAssistCurrency();
  return useQuery({
    queryKey: request ? estimateKey(request, currency) : [...queryKeys.assistEstimate, null],
    queryFn: () => backend().assistEstimate(request!.accountId, request!.method, request!.args, currency),
    enabled: wanted && request !== null,
    // What is left today changes with every call; the prompt only with the mail or the draft.
    staleTime: 60_000,
    retry: false,
  });
}

function resolve(source: EstimateSource): EstimateRequest | null {
  return typeof source === "function" ? source() : source;
}

interface Tip {
  /** Handlers for the element that shows the tooltip. */
  show: (element: Element, byTouch: boolean) => void;
  hide: () => void;
  /** A long press just showed the tooltip. */
  isPressed: () => boolean;
  /** The click after a long press: true (and forgotten) when it is to be swallowed. */
  consumePress: () => boolean;
  startPress: (event: { pointerType: string; currentTarget: Element }) => void;
  endPress: () => void;
  tooltip: ReactNode;
  describedBy: string | undefined;
}

type Place = { left: number; top?: number; bottom?: number };

/** Tooltips are at most this wide (plus a gap where they sit beside a menu item). */
const TIP_WIDTH = 280;

/**
 * Where a tooltip goes: below the element, or above it where the screen ends (the composer's
 * toolbar, a phone). `beside` (menu items): next to the item where there is room, so the tooltip
 * never covers the item below.
 */
export function tipPlace(
  rect: DOMRect,
  beside: boolean,
  viewport = { width: window.innerWidth, height: window.innerHeight },
): Place {
  if (beside) {
    if (rect.right + TIP_WIDTH + 8 <= viewport.width) return { left: rect.right + 8, top: rect.top };
    if (rect.left >= TIP_WIDTH + 8) return { left: rect.left - TIP_WIDTH - 8, top: rect.top };
  }
  const left = Math.max(8, Math.min(rect.left, viewport.width - TIP_WIDTH));
  return rect.bottom + 48 > viewport.height
    ? { left, bottom: viewport.height - rect.top + 6 }
    : { left, top: rect.bottom + 6 };
}

/** The state behind one button's tooltip. `hint` is shown above the estimate, e.g. what the button does. */
function useEstimateTip(source: EstimateSource, hint?: string, beside = false): Tip {
  const { t, i18n } = useT();
  const id = useId();
  const [request, setRequest] = useState<EstimateRequest | null>(null);
  const [position, setPosition] = useState<Place | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);
  // A source that is a plain request follows it once shown (e.g. a debounced instruction).
  const direct = typeof source === "function" ? null : source;
  const current = request === null ? null : (direct ?? request);
  const { data } = useAssistEstimate(current, current !== null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (element: Element, byTouch: boolean) => {
    setRequest(resolve(source));
    setPosition(tipPlace(element.getBoundingClientRect(), beside));
    clearTimeout(timer.current);
    if (byTouch) timer.current = setTimeout(() => setPosition(null), TOUCH_SHOW_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setPosition(null);
  };
  const startPress = (event: { pointerType: string; currentTarget: Element }) => {
    if (event.pointerType === "mouse") return;
    const element = event.currentTarget;
    pressed.current = false;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      pressed.current = true;
      show(element, true);
    }, LONG_PRESS_MS);
  };
  const endPress = () => {
    if (!pressed.current) clearTimeout(timer.current);
  };

  const estimate = data ? estimateText(data, t, i18n.language) : null;
  const breakdown = data ? estimateBreakdown(data, t, i18n.language) : [];
  const lines = [hint, estimate].filter((line): line is string => Boolean(line));
  const tooltip =
    position && lines.length > 0
      ? createPortal(
          <span
            id={id}
            role="tooltip"
            style={position}
            className="pointer-events-none fixed z-50 flex w-max max-w-[min(280px,calc(100vw-16px))] animate-fade flex-col gap-0.5 rounded-lg bg-ink px-2.5 py-1.5 text-[12px] font-medium whitespace-pre-line text-canvas shadow-float"
          >
            {lines.map((line, index) => (
              <span key={index} className={index < lines.length - 1 ? "opacity-80" : undefined}>
                {line}
              </span>
            ))}
            {breakdown.length > 0 && (
              <span className="mt-1 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-px border-t border-canvas/20 pt-1 text-[11.5px]">
                {breakdown.map((line) => (
                  <span key={line.key} className="contents">
                    <span className="opacity-70">{line.label}</span>
                    <span>{line.value}</span>
                  </span>
                ))}
              </span>
            )}
            {data?.calibrated && <span className="text-[11px] opacity-70">{t("assist.estimate.calibrated")}</span>}
          </span>,
          document.body,
        )
      : null;
  const isPressed = () => pressed.current;
  const consumePress = () => {
    if (!pressed.current) return false;
    pressed.current = false;
    return true;
  };
  return { show, hide, isPressed, consumePress, startPress, endPress, tooltip, describedBy: tooltip ? id : undefined };
}

/**
 * Wraps a button (or a few): the estimate shows while the mouse rests on it or it has the
 * keyboard's focus, and after a long press on a touch screen, which then doesn't click it.
 */
export function EstimateTip({
  request,
  hint,
  children,
  className,
}: {
  request: EstimateSource;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const tip = useEstimateTip(request, hint);
  return (
    <span
      className={clsx("inline-flex", className)}
      aria-describedby={tip.describedBy}
      onPointerEnter={(event: ReactPointerEvent<HTMLSpanElement>) => {
        if (event.pointerType === "mouse") tip.show(event.currentTarget, false);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") tip.hide();
      }}
      onFocus={(event) => {
        if (focusVisible(event.target)) tip.show(event.currentTarget, false);
      }}
      onBlur={tip.hide}
      onPointerDown={tip.startPress}
      onPointerUp={tip.endPress}
      onPointerCancel={tip.endPress}
      onContextMenu={(event) => {
        // The long press is ours, not the system's menu.
        if (tip.isPressed()) event.preventDefault();
      }}
      onClickCapture={(event) => {
        if (!tip.consumePress()) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
      {tip.tooltip}
    </span>
  );
}

/**
 * A menu item's label with the estimate: it listens on the whole item it sits in (hover, focus,
 * long press), since the menu draws the item itself.
 */
export function EstimateLabel({ request, children }: { request: EstimateSource; children: ReactNode }) {
  // Beside the item, so the tooltip never covers the one below it.
  const tip = useEstimateTip(request, undefined, true);
  const anchor = useRef<HTMLSpanElement>(null);
  const handle = useEffectEvent((item: HTMLElement, event: Event) => {
    const pointer = event instanceof PointerEvent ? event.pointerType : "";
    switch (event.type) {
      case "pointerenter":
        if (pointer === "mouse") tip.show(item, false);
        break;
      case "pointerleave":
        if (pointer === "mouse") tip.hide();
        break;
      case "focus":
        if (focusVisible(item)) tip.show(item, false);
        break;
      case "blur":
        tip.hide();
        break;
      case "pointerdown":
        tip.startPress({ pointerType: pointer, currentTarget: item });
        break;
      case "pointerup":
      case "pointercancel":
        tip.endPress();
        break;
      case "contextmenu":
        if (tip.isPressed()) event.preventDefault();
        break;
      case "click":
        if (!tip.consumePress()) return;
        event.preventDefault();
        event.stopPropagation();
        break;
    }
  });
  useEffect(() => {
    const item = anchor.current?.closest<HTMLElement>("[role=menuitem]");
    if (!item) return;
    const listener = (event: Event) => handle(item, event);
    const types = ["pointerenter", "pointerleave", "focus", "blur", "pointerdown", "pointerup", "pointercancel"];
    for (const type of [...types, "contextmenu"]) item.addEventListener(type, listener);
    item.addEventListener("click", listener, true);
    return () => {
      for (const type of [...types, "contextmenu"]) item.removeEventListener(type, listener);
      item.removeEventListener("click", listener, true);
    };
  }, []);
  useEffect(() => {
    const item = anchor.current?.closest<HTMLElement>("[role=menuitem]");
    if (!item) return;
    if (tip.describedBy) item.setAttribute("aria-describedby", tip.describedBy);
    else item.removeAttribute("aria-describedby");
  }, [tip.describedBy]);
  return (
    <span ref={anchor} className="contents">
      {children}
      {tip.tooltip}
    </span>
  );
}

/** Focus that came from the keyboard, not from a click or the menu opening under the pointer. */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** A value that follows `value` only once it stopped changing for `delay` ms (typing). */
export function useSettled<T>(value: T, delay = 600): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
