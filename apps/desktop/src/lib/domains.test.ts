import { describe, expect, it } from "vitest";
import {
  decodePunycode,
  isIpAddress,
  isLookalikeHost,
  isPunycodeHost,
  isSharedHost,
  registrableDomain,
  unicodeHost,
} from "./domains";

describe("registrableDomain", () => {
  it("keeps the last two labels", () => {
    expect(registrableDomain("mail.shop.example.org")).toBe("example.org");
    expect(registrableDomain("EXAMPLE.org.")).toBe("example.org");
    expect(registrableDomain("example.org")).toBe("example.org");
    expect(registrableDomain("localhost")).toBe("localhost");
  });

  it("knows common multi-label suffixes", () => {
    expect(registrableDomain("www.shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("a.b.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("news.example.co.jp")).toBe("example.co.jp");
    expect(registrableDomain("someone.github.io")).toBe("someone.github.io");
    expect(registrableDomain("co.uk")).toBe("co.uk");
  });

  it("leaves IP addresses whole", () => {
    expect(registrableDomain("192.0.2.10")).toBe("192.0.2.10");
    expect(isIpAddress("192.0.2.10")).toBe(true);
    expect(isIpAddress("[2001:db8::1]")).toBe(true);
    expect(isIpAddress("example.org")).toBe(false);
  });

  it("marks hosts where anyone can publish", () => {
    expect(isSharedHost("amazonaws.com")).toBe(true);
    expect(isSharedHost("github.io")).toBe(true);
    expect(isSharedHost("co.uk")).toBe(true);
    expect(isSharedHost("example.org")).toBe(false);
  });
});

describe("punycode", () => {
  it("decodes internationalized labels", () => {
    expect(decodePunycode("mnchen-3ya")).toBe("münchen");
    expect(decodePunycode("bcher-kva")).toBe("bücher");
    expect(decodePunycode("fiqs8s")).toBe("中国");
    expect(decodePunycode("ls8h")).toBe("💩");
    expect(unicodeHost("www.xn--mnchen-3ya.example")).toBe("www.münchen.example");
  });

  it("gives up on garbage instead of guessing", () => {
    expect(decodePunycode("99999999999999999999")).toBeNull();
    expect(decodePunycode("abc-!!")).toBeNull();
    expect(decodePunycode("ü-abc")).toBeNull();
    expect(unicodeHost("xn--!!.example")).toBe("xn--!!.example");
  });

  it("tells punycode hosts apart", () => {
    expect(isPunycodeHost("xn--mnchen-3ya.example")).toBe(true);
    expect(isPunycodeHost("example.org")).toBe(false);
  });
});

describe("isLookalikeHost", () => {
  it("flags mixed scripts and all-lookalike labels", () => {
    expect(isLookalikeHost("xn--pypal-4ve.example")).toBe(true); // pаypal with a Cyrillic а
    expect(isLookalikeHost("xn--80ak6aa92e.example")).toBe(true); // аррӏе, all Cyrillic
  });

  it("lets honest international names be", () => {
    expect(isLookalikeHost("xn--mnchen-3ya.example")).toBe(false);
    expect(isLookalikeHost("xn--e1afmkfd.example")).toBe(false); // пример
    expect(isLookalikeHost("xn--fiqs8s.example")).toBe(false);
    expect(isLookalikeHost("example.org")).toBe(false);
  });
});
