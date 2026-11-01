import { useEffect, useState } from "react";
import type { VerificationCode } from "./types";

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

/**
 * The sign-in codes of recent mail, across accounts.
 *
 * TODO(main session): fill from JMAP `VerificationCode/query` (and `Email/verification` for the
 * reader) once the server offers it; until then production builds have none.
 */
export function useVerificationCodes(): VerificationCode[] {
  const [codes] = useState<VerificationCode[]>(() => (wantsDemo() ? demoCodes() : []));
  return codes;
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
