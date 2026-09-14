import { describe, expect, it } from "vitest";
import { claimedHost, isOpenableLink, misleadingLink, targetHost } from "./links";

describe("links", () => {
  it("opens only web and mail links", () => {
    expect(isOpenableLink("https://uwumail.dev")).toBe(true);
    expect(isOpenableLink("mailto:leni@example.com")).toBe(true);
    expect(isOpenableLink("javascript:alert(1)")).toBe(false);
    expect(isOpenableLink("file:///C:/Windows/System32/calc.exe")).toBe(false);
  });

  it("reads the real and the claimed host", () => {
    expect(targetHost("https://www.PayPal.de/login?x=1")).toBe("paypal.de");
    expect(targetHost("mailto:hilfe@bank.example?subject=Hi")).toBe("bank.example");
    expect(claimedHost("www.paypal.de")).toBe("paypal.de");
    expect(claimedHost("https://paypal.de/konto.")).toBe("paypal.de");
    expect(claimedHost("Hier klicken")).toBeNull();
    expect(claimedHost("support@bank.example")).toBe("bank.example");
  });

  it("flags text that names another site than the target", () => {
    expect(misleadingLink("https://paypa1-login.xyz/de", "paypal.de")).toEqual({
      shown: "paypal.de",
      actual: "paypa1-login.xyz",
    });
    expect(misleadingLink("https://mail.paypal.de/abc", "www.paypal.de")).toBeNull();
    expect(misleadingLink("https://tracking.example/r?u=1", "Jetzt ansehen")).toBeNull();
    expect(misleadingLink("mailto:evil@phish.example", "service@bank.example")).toEqual({
      shown: "bank.example",
      actual: "phish.example",
    });
  });
});
