import { ACCOUNT_COLORS, type AccountColor, type Address } from "@/backend/types";

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Compact date for list rows: time today, "Yesterday", weekday this week, date otherwise. */
export function formatListDate(iso: string, locale: string, yesterday: string, now = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return yesterday;
  if (days < 7) return date.toLocaleDateString(locale, { weekday: "short" });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
  }
  return date.toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "2-digit" });
}

export function formatFullDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function formatSize(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}

export function displayName(address: Address): string {
  return address.name?.trim() || address.email.split("@")[0] || address.email;
}

export function formatAddress(address: Address): string {
  return address.name ? `${address.name} <${address.email}>` : address.email;
}

export function initials(address: Address): string {
  const name = displayName(address);
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts[parts.length - 1]![0]}` : name.slice(0, 2);
  return letters.toUpperCase();
}

export function colorFor(key: string): AccountColor {
  let hash = 0;
  for (const char of key.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ACCOUNT_COLORS[hash % ACCOUNT_COLORS.length]!;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/** Parses "Name <a@b.c>" or "a@b.c". Returns null for anything else. */
export function parseAddress(value: string): Address | null {
  const trimmed = value.trim().replace(/[,;]$/, "");
  const match = /^(.*?)\s*<([^>]+)>$/.exec(trimmed);
  if (match) {
    const email = match[2]!.trim();
    if (!isEmail(email)) return null;
    const name = match[1]!.replace(/^"|"$/g, "").trim();
    return name ? { name, email } : { email };
  }
  return isEmail(trimmed) ? { email: trimmed } : null;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
