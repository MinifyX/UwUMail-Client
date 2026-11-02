import clsx from "clsx";
import { Hint, Icon, IconButton, ICONS, Tag, Tooltip } from "@uwusuite/design";
import { useEffect, useRef, useState } from "react";
import { useT } from "@/i18n";
import { openExternal } from "@/lib/platform";
import { toast } from "@/state/toasts";
import { activeCodes, copyToClipboard, formatRemaining, groupCode, secondsLeft } from "./format";
import type { VerificationCode } from "./types";
import { useNow } from "./useVerificationCodes";

/** Copies a code: a toast says so, and the button shows a tick for a moment. */
function useCopy() {
  const { t } = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (code: VerificationCode) => {
    if (!code.code) return;
    if (await copyToClipboard(code.code)) {
      setCopied(code.id);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 1600);
      toast(t("codes.copied", { code: groupCode(code.code) }), "success");
    } else {
      toast(t("codes.copyFailed"), "error");
    }
  };
  return { copied, copy };
}

function CodeIcon({ code, className }: { code: VerificationCode; className?: string }) {
  const icon = code.kind === "link" ? ICONS.link : code.source === "heuristic" ? ICONS.warning : ICONS.securityCheck;
  return (
    <Icon
      icon={icon}
      size="sm"
      className={clsx(code.source === "heuristic" ? "text-warning" : "text-pink-ink", "shrink-0", className)}
    />
  );
}

function CodeChip({
  code,
  seconds,
  copied,
  onCopy,
}: {
  code: VerificationCode;
  seconds: number;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useT();
  const link = code.kind === "link";
  const unconfirmed = code.source === "heuristic" || !code.autofill;
  return (
    <li
      data-code-chip
      className={clsx(
        "flex h-11 shrink-0 items-center gap-2.5 rounded-2xl border bg-surface py-1 pr-1 pl-3",
        code.source === "heuristic" ? "border-dashed border-warning/60" : "border-hairline",
      )}
    >
      <CodeIcon code={code} />
      {link ? (
        <span className="text-[13.5px] font-bold text-ink">{t("codes.link")}</span>
      ) : (
        <span className="font-mono text-[15px] font-bold tracking-[0.02em] text-ink tabular-nums">
          {groupCode(code.code ?? "")}
        </span>
      )}
      <span className="flex flex-col text-[11.5px] leading-tight text-muted">
        <span className="max-w-[160px] truncate">{code.origin}</span>
        <span className={clsx("tabular-nums", seconds < 60 && "font-semibold text-warning-ink")}>
          {t("codes.remaining", { time: formatRemaining(seconds) })}
        </span>
      </span>
      {unconfirmed && (
        <Tooltip content={link ? t("codes.linkNoAutofill") : t("codes.noAutofillHint")}>
          <Tag tone="warning">{t("codes.noAutofill")}</Tag>
        </Tooltip>
      )}
      {link ? (
        <button
          type="button"
          aria-label={t("codes.openLabel", { origin: code.origin })}
          onClick={() => code.url && void openExternal(code.url)}
          className="h-8 rounded-xl bg-pink-tint px-3 text-[12.5px] font-bold text-pink-ink hover:bg-pink-tint-strong focus-visible:shadow-focus focus-visible:outline-none"
        >
          {t("codes.open")}
        </button>
      ) : (
        <IconButton
          size="sm"
          icon={copied ? ICONS.done : ICONS.copy}
          label={t("codes.copy", { code: groupCode(code.code ?? "") })}
          onClick={onCopy}
        />
      )}
    </li>
  );
}

/**
 * The sign-in codes of recent mail as a quiet row of chips above the list: copy with one click,
 * counting down until they expire. Nothing at all without a working code.
 */
export function VerificationCodeBar({ codes, className }: { codes: readonly VerificationCode[]; className?: string }) {
  const { t } = useT();
  const now = useNow(codes.length > 0);
  const { copied, copy } = useCopy();
  const active = activeCodes(codes, now);
  if (active.length === 0) return null;
  return (
    <ul
      aria-label={t("codes.bar")}
      className={clsx("flex [scrollbar-width:none] gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden", className)}
    >
      {active.map((code) => (
        <CodeChip
          key={code.id}
          code={code}
          seconds={secondsLeft(code, now)}
          copied={copied === code.id}
          onCopy={() => void copy(code)}
        />
      ))}
    </ul>
  );
}

/** The small "Code" mark before the subject of a mail that carries a working code. */
export function SubjectCodeChip({ code }: { code: VerificationCode }) {
  const { t } = useT();
  return (
    <span
      className={clsx(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-bold",
        code.source === "heuristic" ? "bg-warning-tint text-warning-ink" : "bg-pink-tint text-pink-ink",
      )}
    >
      <Icon icon={code.kind === "link" ? ICONS.link : ICONS.oneTimeCode} size="xs" />
      {code.kind === "link" ? t("codes.link") : t("codes.chip")}
    </span>
  );
}

/** In the reader, above the mail: where the code is from and whether it may be filled in. */
export function ReaderCodeHint({ code, className }: { code: VerificationCode; className?: string }) {
  const { t } = useT();
  const now = useNow(true);
  const { copied, copy } = useCopy();
  const seconds = secondsLeft(code, now);
  const expired = seconds === 0;
  const tone = expired ? "info" : code.source === "heuristic" ? "warning" : "success";
  const text = expired
    ? t("codes.banner.expired")
    : code.source === "heuristic"
      ? t("codes.banner.heuristic")
      : code.kind === "link"
        ? t("codes.banner.link")
        : code.autofill
          ? t("codes.banner.signed", { origin: code.origin })
          : t("codes.banner.signedNoAutofill");
  return (
    <Hint tone={tone} className={clsx("flex items-center gap-3", className)}>
      <CodeIcon code={code} />
      <span className="min-w-0 flex-1">
        {!expired && code.kind === "otp" && (
          <span className="mr-2 font-mono font-bold tabular-nums">{groupCode(code.code ?? "")}</span>
        )}
        {text}
      </span>
      {!expired &&
        (code.kind === "link" ? (
          <button
            type="button"
            aria-label={t("codes.openLabel", { origin: code.origin })}
            onClick={() => code.url && void openExternal(code.url)}
            className="h-8 shrink-0 rounded-xl px-3 text-[12.5px] font-bold hover:bg-ink/5"
          >
            {t("codes.open")}
          </button>
        ) : (
          <IconButton
            size="sm"
            icon={copied === code.id ? ICONS.done : ICONS.copy}
            label={t("codes.copy", { code: groupCode(code.code ?? "") })}
            onClick={() => void copy(code)}
          />
        ))}
    </Hint>
  );
}
