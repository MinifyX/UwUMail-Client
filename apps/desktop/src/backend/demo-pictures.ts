// Made-up logos for the demo companies. People's own domains get none, like in real life.
import type { SenderPicture } from "./types";

const svg = (body: string) =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${body}</svg>`,
  )}`;

const PICTURES: Record<string, SenderPicture> = {
  "uwumail.dev": {
    kind: "logo",
    url: svg(
      `<rect width="64" height="64" fill="#ff5c96"/><rect x="11" y="17" width="42" height="30" rx="6" fill="#fff"/>` +
        `<g fill="none" stroke="#f0357f" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M16 22 L25.5 34.5 L32 29.7 L38.5 34.5 L48 22"/><path d="M23.7 23.7v.8a2.3 2.3 0 0 0 4.6 0v-.8"/>` +
        `<path d="M35.7 23.7v.8a2.3 2.3 0 0 0 4.6 0v-.8"/></g>`,
    ),
  },
  "kaffeekuchen.example": {
    kind: "icon",
    url: svg(
      `<path d="M14 26h30v12a13 13 0 0 1-13 13h-4a13 13 0 0 1-13-13z" fill="#8a4b2a"/>` +
        `<path d="M44 30h3a6 6 0 0 1 0 12h-4" fill="none" stroke="#8a4b2a" stroke-width="4"/>` +
        `<path d="M22 20c0-4 4-4 4-8M30 20c0-4 4-4 4-8" fill="none" stroke="#e0a27a" stroke-width="3" stroke-linecap="round"/>`,
    ),
  },
  "pixelparts.example": {
    kind: "logo",
    url: svg(
      `<rect width="64" height="64" fill="#1f2a5c"/>` +
        `<g fill="#6ee7ff"><rect x="16" y="16" width="10" height="10"/><rect x="27" y="16" width="10" height="10"/>` +
        `<rect x="16" y="27" width="10" height="10"/><rect x="38" y="27" width="10" height="10" fill="#ffd166"/>` +
        `<rect x="16" y="38" width="10" height="10"/><rect x="27" y="38" width="10" height="10" fill="#ff7aa8"/></g>`,
    ),
  },
  // Transparent logos: a colorful one gets a white backdrop, a white one a dark backdrop.
  "sparschwein.example": {
    kind: "logo",
    url: svg(
      `<ellipse cx="30" cy="36" rx="22" ry="17" fill="#ff7fac"/><circle cx="51" cy="35" r="6" fill="#f0357f"/>` +
        `<circle cx="40" cy="30" r="2.2" fill="#0f7b5a"/><rect x="22" y="15" width="14" height="4" rx="2" fill="#0f7b5a"/>` +
        `<rect x="16" y="49" width="6" height="8" rx="2" fill="#f0357f"/><rect x="36" y="49" width="6" height="8" rx="2" fill="#f0357f"/>`,
    ),
  },
  "brightlabs.example": {
    kind: "icon",
    url: svg(
      `<circle cx="32" cy="28" r="13" fill="#ffb703"/><rect x="26" y="42" width="12" height="9" rx="3" fill="#6b7280"/>` +
        `<g stroke="#ffb703" stroke-width="3" stroke-linecap="round"><path d="M32 6v5M12 28H7M57 28h-5M17 13l3 3M47 13l-3 3"/></g>`,
    ),
  },
  "pixelstudio.example": {
    kind: "logo",
    url: svg(
      `<circle cx="32" cy="32" r="26" fill="none" stroke="#fff" stroke-width="5"/>` +
        `<path d="M26 20 L45 32 L26 44 Z" fill="#fff"/>`,
    ),
  },
};

export function demoSenderPicture(email: string): SenderPicture | null {
  const domain = email.split("@").pop()?.toLowerCase() ?? "";
  return PICTURES[domain] ?? null;
}

/**
 * A newsletter banner drawn for white paper, like many shops send them: dark type on white,
 * some colored keycaps. Shows off how images are recolored in dark mode.
 */
export function demoBanner(title: string, line: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const key = (x: number, fill: string, label: string) =>
    `<rect x="${x}" y="112" width="56" height="56" rx="10" fill="${fill}"/>` +
    `<text x="${x + 28}" y="148" text-anchor="middle" font-size="22" font-weight="700" fill="#fff">${label}</text>`;
  const body =
    `<rect width="480" height="200" fill="#fff"/><rect x="0.5" y="0.5" width="479" height="199" fill="none" stroke="#d8d4dc"/>` +
    `<g font-family="Segoe UI, Helvetica, Arial, sans-serif">` +
    `<text x="24" y="52" font-size="28" font-weight="700" fill="#1c1420">${escape(title)}</text>` +
    `<text x="24" y="82" font-size="15" fill="#4a4250">${escape(line)}</text>` +
    key(24, "#ff4d8d", "U") +
    key(88, "#7c5cff", "w") +
    key(152, "#ff4d8d", "U") +
    `<text x="232" y="148" font-size="15" fill="#1c1420">pixelparts.example</text></g>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 200" width="480" height="200">${body}</svg>`,
  )}`;
}
