import { describe, expect, it } from "vitest";
import { unwrapSafeLink } from "./safeLinks";

const wrap = (host: string, target: string) =>
  `https://${host}/?url=${encodeURIComponent(target)}&data=05%7C02%7C%7Cabc&sdata=xyz&reserved=0`;

describe("unwrapSafeLink", () => {
  it("reads the original address of Outlook Safe Links in every Microsoft cloud", () => {
    for (const host of [
      "eur01.safelinks.protection.outlook.com",
      "nam12.safelinks.protection.outlook.com",
      "gcc02.safelinks.protection.office365.us",
      "safelinks.protection.apps.mil",
      "can01.safelinks.protection.partner.outlook.cn",
    ]) {
      expect(unwrapSafeLink(wrap(host, "https://wanders.example/clip?v=2&t=1"))).toEqual({
        url: "https://wanders.example/clip?v=2&t=1",
        wrapper: host,
      });
    }
  });

  it("reads Defender's newer paths and the Teams wrapper", () => {
    expect(
      unwrapSafeLink(
        `https://nam02.safelinks.protection.outlook.com/ap/w-59584e83/?url=${encodeURIComponent("https://docs.example/a")}`,
      )?.url,
    ).toBe("https://docs.example/a");
    expect(
      unwrapSafeLink(
        `https://statics.teams.cdn.office.net/evergreen-assets/safelinks/1/atp-safelinks.html?url=${encodeURIComponent("https://docs.example/b")}&locale=de-de`,
      ),
    ).toEqual({ url: "https://docs.example/b", wrapper: "statics.teams.cdn.office.net" });
    expect(unwrapSafeLink("https://EUR01.SafeLinks.Protection.Outlook.com/?URL=https%3A%2F%2Fa.example%2F")?.url).toBe(
      "https://a.example/",
    );
  });

  it("unwraps a Safe Link inside a Safe Link", () => {
    const inner = wrap("eur02.safelinks.protection.outlook.com", "https://end.example/x");
    expect(unwrapSafeLink(wrap("eur01.safelinks.protection.outlook.com", inner))).toEqual({
      url: "https://end.example/x",
      wrapper: "eur01.safelinks.protection.outlook.com",
    });
  });

  it("leaves everything else alone", () => {
    expect(unwrapSafeLink("https://wanders.example/?url=https%3A%2F%2Fother.example%2F")).toBeNull();
    expect(unwrapSafeLink(wrap("safelinks.protection.outlook.com.evil.example", "https://a.example/"))).toBeNull();
    expect(unwrapSafeLink(wrap("fakesafelinks.protection.outlook.com.example", "https://a.example/"))).toBeNull();
    expect(unwrapSafeLink("https://statics.teams.cdn.office.net/other/?url=https%3A%2F%2Fa.example%2F")).toBeNull();
    expect(unwrapSafeLink("https://eur01.safelinks.protection.outlook.com/?data=05")).toBeNull();
    expect(unwrapSafeLink("mailto:someone@example.org")).toBeNull();
  });

  it("unwraps wrapped mail links, plain and encoded", () => {
    const host = "eur01.safelinks.protection.outlook.com";
    expect(unwrapSafeLink(wrap(host, "mailto:leni@example.com?subject=Hi"))?.url).toBe(
      "mailto:leni@example.com?subject=Hi",
    );
    expect(unwrapSafeLink(wrap(host, encodeURIComponent("mailto:leni@example.com")))?.url).toBe(
      "mailto:leni@example.com",
    );
  });

  it("never unwraps to anything but a web or mail address", () => {
    for (const target of ["javascript:alert(1)", "file:///C:/Windows/System32/calc.exe", "data:text/html,hi"]) {
      expect(unwrapSafeLink(wrap("eur01.safelinks.protection.outlook.com", target))).toBeNull();
    }
  });
});
