// The privacy proxy's address may carry a login (`socks5://user:secret@host:1080`). Settings show
// it with the password hidden and keep the saved one while it stays hidden (security-audit EG-6).

/** What the settings show in place of the proxy's password. */
export const HIDDEN_PASSWORD = "••••••";

/** Scheme, `//`, user name, `:`, password, `@`. */
const LOGIN = /^([a-z][a-z0-9+.-]*:\/\/[^:@/?#\s]*):([^@/?#\s]*)@/i;

/** The proxy address as the settings show it: a password is replaced by HIDDEN_PASSWORD. */
export function hideProxyPassword(proxy: string): string {
  return proxy.replace(LOGIN, (whole, user: string, password: string) =>
    password ? `${user}:${HIDDEN_PASSWORD}@` : whole,
  );
}

/**
 * The address to save from what was typed: where the password still reads HIDDEN_PASSWORD, the
 * saved one, but only for the same scheme and user name (a changed login needs its password).
 */
export function withSavedProxyPassword(typed: string, saved: string): string {
  const shown = LOGIN.exec(typed);
  if (!shown || shown[2] !== HIDDEN_PASSWORD) return typed;
  const kept = LOGIN.exec(saved);
  if (!kept || kept[1]!.toLowerCase() !== shown[1]!.toLowerCase()) return typed;
  return `${shown[1]}:${kept[2]}@${typed.slice(shown[0].length)}`;
}
