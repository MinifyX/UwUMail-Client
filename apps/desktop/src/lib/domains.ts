// Host names in links: the part that says who owns a site, internationalized names read back
// from their xn-- form, and names that only look like another one.

/**
 * Public suffixes with more than one label that a site can sit directly under. Not the whole
 * Public Suffix List, just the ones mail links actually use: country second levels and
 * hosting platforms where every subdomain belongs to someone else.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom, Australia, New Zealand, South Africa
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "ltd.uk",
  "plc.uk",
  "me.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "co.nz",
  "org.nz",
  "net.nz",
  "govt.nz",
  "co.za",
  "org.za",
  // Asia
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "co.kr",
  "or.kr",
  "com.cn",
  "net.cn",
  "org.cn",
  "com.hk",
  "com.tw",
  "com.sg",
  "com.my",
  "co.in",
  "net.in",
  "org.in",
  "co.id",
  "co.th",
  "com.vn",
  "com.ph",
  "com.pk",
  // Europe, Middle East
  "co.at",
  "or.at",
  "gv.at",
  "ac.at",
  "com.tr",
  "com.pl",
  "com.ua",
  "com.cy",
  "co.il",
  "org.il",
  "com.sa",
  "com.eg",
  // Americas
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "com.uy",
  // Hosting platforms: each subdomain is its own site
  "github.io",
  "gitlab.io",
  "blogspot.com",
  "wordpress.com",
  "wixsite.com",
  "herokuapp.com",
  "netlify.app",
  "vercel.app",
  "pages.dev",
  "workers.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "azurewebsites.net",
  "sharepoint.com",
  "myshopify.com",
  "onrender.com",
  "fly.dev",
  "glitch.me",
  "ngrok.io",
  "ngrok-free.app",
  "duckdns.org",
]);

/**
 * Shared storage and delivery hosts: anyone can put a page there, so trusting the whole name is
 * never offered.
 */
const SHARED_HOSTS = new Set([
  "amazonaws.com",
  "cloudfront.net",
  "googleapis.com",
  "googleusercontent.com",
  "windows.net",
  "azureedge.net",
  "r2.dev",
  "digitaloceanspaces.com",
  "backblazeb2.com",
  "ipfs.io",
]);

export function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/**
 * The part of a host name its owner registered: `mail.shop.example.co.uk` → `example.co.uk`.
 * A heuristic (last two labels, three under the suffixes above), not the full Public Suffix List.
 */
export function registrableDomain(host: string): string {
  const clean = host.toLowerCase().replace(/\.$/, "");
  if (isIpAddress(clean)) return clean;
  const labels = clean.split(".");
  if (labels.length <= 2) return clean;
  return labels.slice(MULTI_LABEL_SUFFIXES.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

/** A name where anyone can host a page, so a whole site cannot be trusted by it. */
export function isSharedHost(domain: string): boolean {
  return SHARED_HOSTS.has(domain) || MULTI_LABEL_SUFFIXES.has(domain);
}

// Punycode (RFC 3492), decoding only: shows `xn--mnchen-3ya` as `münchen`.
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;

function adapt(delta: number, points: number, first: boolean) {
  let value = first ? Math.floor(delta / DAMP) : delta >> 1;
  value += Math.floor(value / points);
  let k = 0;
  while (value > ((BASE - T_MIN) * T_MAX) >> 1) {
    value = Math.floor(value / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * value) / (value + SKEW));
}

function digitOf(code: number) {
  if (code >= 0x30 && code <= 0x39) return code - 22; // 0-9 → 26-35
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
  return -1;
}

/** Decodes the part after `xn--`, or returns null for anything that is not valid Punycode. */
export function decodePunycode(input: string): string | null {
  const output: number[] = [];
  const delimiter = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(delimiter, 0); j++) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length;) {
    const old = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitOf(input.charCodeAt(index++));
      if (digit < 0) return null;
      i += digit * weight;
      if (!Number.isSafeInteger(i)) return null;
      const threshold = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < threshold) break;
      weight *= BASE - threshold;
    }
    bias = adapt(i - old, output.length + 1, old === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i, 0, n);
    i++;
  }
  return String.fromCodePoint(...output);
}

/** The host with every `xn--` label decoded; labels that don't decode stay as they are. */
export function unicodeHost(host: string): string {
  return host
    .split(".")
    .map((label) => (/^xn--/i.test(label) ? (decodePunycode(label.slice(4).toLowerCase()) ?? label) : label))
    .join(".");
}

export function isPunycodeHost(host: string): boolean {
  return host.split(".").some((label) => /^xn--/i.test(label));
}

type Script = "latin" | "cyrillic" | "greek" | "armenian" | "cherokee";

function scriptOf(char: string): Script | "other" | null {
  if (!/\p{L}/u.test(char)) return null;
  if (/\p{Script=Latin}/u.test(char)) return "latin";
  if (/\p{Script=Cyrillic}/u.test(char)) return "cyrillic";
  if (/\p{Script=Greek}/u.test(char)) return "greek";
  if (/\p{Script=Armenian}/u.test(char)) return "armenian";
  if (/\p{Script=Cherokee}/u.test(char)) return "cherokee";
  return "other";
}

/** Cyrillic and Greek letters that are hard to tell from Latin ones. */
const LATIN_LOOKALIKES = new Set([..."аеорсухіјѕԁһӏԛԝкмнтвпьѵѡοαικνρτυχεβζημ"]);

/**
 * A decoded host whose letters pretend to be Latin: scripts mixed within one label (`pаypal`
 * with a Cyrillic а), or a label made only of Cyrillic or Greek letters that all look Latin.
 */
export function isLookalikeHost(host: string): boolean {
  return unicodeHost(host)
    .split(".")
    .some((label) => {
      const scripts = new Set<string>();
      const letters: string[] = [];
      for (const char of label) {
        const script = scriptOf(char);
        if (!script) continue;
        scripts.add(script);
        letters.push(char);
      }
      const confusable = [...scripts].filter((script) => script !== "other");
      if (confusable.length > 1) return true;
      const only = confusable[0];
      return (
        scripts.size === 1 &&
        only !== undefined &&
        only !== "latin" &&
        letters.length > 0 &&
        letters.every((char) => LATIN_LOOKALIKES.has(char.toLowerCase()))
      );
    });
}
