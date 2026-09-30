import { describe, expect, it } from "vitest";
import { HIDDEN_PASSWORD, hideProxyPassword, withSavedProxyPassword } from "./proxyLogin";

describe("the privacy proxy's login (EG-6)", () => {
  const saved = "socks5://mini:s3cr:et@proxy.example:1080";

  it("is shown without its password", () => {
    const shown = hideProxyPassword(saved);
    expect(shown).toBe(`socks5://mini:${HIDDEN_PASSWORD}@proxy.example:1080`);
    expect(shown).not.toContain("s3cr");
    expect(hideProxyPassword("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
    expect(hideProxyPassword("http://mini@proxy.example:3128")).toBe("http://mini@proxy.example:3128");
  });

  it("keeps the saved password while it stays hidden", () => {
    const shown = hideProxyPassword(saved);
    expect(withSavedProxyPassword(shown, saved)).toBe(saved);
    expect(withSavedProxyPassword(shown.replace("1080", "1081"), saved)).toBe(
      "socks5://mini:s3cr:et@proxy.example:1081",
    );
  });

  it("takes a new password as typed, and never hands the old one to another login", () => {
    expect(withSavedProxyPassword("socks5://mini:neu@proxy.example:1080", saved)).toBe(
      "socks5://mini:neu@proxy.example:1080",
    );
    const otherUser = `socks5://leni:${HIDDEN_PASSWORD}@proxy.example:1080`;
    expect(withSavedProxyPassword(otherUser, saved)).toBe(otherUser);
    const otherScheme = `http://mini:${HIDDEN_PASSWORD}@proxy.example:1080`;
    expect(withSavedProxyPassword(otherScheme, saved)).toBe(otherScheme);
  });
});
