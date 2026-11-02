import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { backend } from "@/backend/backend";
import { queryKeys } from "@/lib/queries";
import type { VerificationCode } from "./types";

/** At the latest this often the list is asked again; the earliest expiry asks sooner. */
const MAX_REFRESH_MS = 60_000;
const NO_CODES: VerificationCode[] = [];

/**
 * Placeholder codes for looking at the design: dev builds with `?demoCodes` in the address only.
 * Reserved names throughout (RFC 2606).
 */
export function demoCodes(now = Date.now()): VerificationCode[] {
  const at = (seconds: number) => new Date(now + seconds * 1000).toISOString();
  return [
    {
      id: "vc-bank",
      emailId: "msg-demo-bank",
      threadId: "thr-14",
      kind: "otp",
      code: "482913",
      origin: "bank.example",
      sender: "Bank Beispiel",
      purpose: "login",
      source: "header",
      autofill: true,
      expiresAt: at(4 * 60 + 12),
    },
    {
      id: "vc-shop",
      emailId: "msg-demo-shop",
      threadId: "thr-6",
      kind: "otp",
      code: "7305",
      origin: "shop.example.com",
      sender: "Shop",
      purpose: "confirm-action",
      source: "heuristic",
      autofill: false,
      expiresAt: at(48),
    },
    {
      id: "vc-forum",
      emailId: "msg-demo-forum",
      threadId: "thr-16",
      kind: "link",
      url: "https://forum.example.net/login/confirm",
      origin: "forum.example.net",
      sender: "Forum",
      purpose: "login",
      source: "header",
      autofill: false,
      expiresAt: at(14 * 60),
    },
  ];
}

function wantsDemo() {
  if (!import.meta.env.DEV || typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).has("demoCodes");
}

/** How long until the first of `codes` runs out (then the list is asked again), at most a minute. */
export function nextRefreshMs(codes: readonly VerificationCode[], now = Date.now()): number {
  let next = MAX_REFRESH_MS;
  for (const code of codes) {
    const left = Date.parse(code.expiresAt) - now;
    if (Number.isFinite(left)) next = Math.min(next, Math.max(left, 0) + 500);
  }
  return Math.max(next, 1_000);
}

/** The codes still valid at `now`. */
export function validCodes(codes: readonly VerificationCode[], now = Date.now()): VerificationCode[] {
  return codes.filter((code) => Date.parse(code.expiresAt) > now);
}

/**
 * The sign-in codes of recent mail, across accounts: what the UwUMail servers found
 * (`urn:uwumail:jmap:verification`, see Backend.verificationCodes). Asked again when mail comes
 * or changes (lib/queries.ts) and when the earliest code runs out; the countdown runs here.
 */
export function useVerificationCodes(): VerificationCode[] {
  const [demo] = useState<VerificationCode[] | null>(() => (wantsDemo() ? demoCodes() : null));
  const { data } = useQuery({
    queryKey: queryKeys.verificationCodes,
    queryFn: async () => validCodes(await backend().verificationCodes()),
    enabled: demo === null,
    refetchInterval: (query) => nextRefreshMs(query.state.data ?? NO_CODES),
    // A code is a secret for minutes: never kept once nothing shows it.
    gcTime: 0,
  });
  return demo ?? data ?? NO_CODES;
}

/** `Date.now()`, again every `ms` while `active`. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [active, ms]);
  return now;
}
