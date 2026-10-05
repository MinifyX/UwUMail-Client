import { describe, expect, it } from "vitest";
import type { MaskedAddress } from "@/backend/types";
import {
  countByFilter,
  filterOf,
  maskedInput,
  maskedProblems,
  newestFirst,
  openableUrl,
  siteLabel,
  siteOrigin,
  visibleMasked,
} from "./maskedAddresses";

const masked = (patch: Partial<MaskedAddress> & Pick<MaskedAddress, "id" | "email">): MaskedAddress => ({
  state: "enabled",
  forDomain: "",
  description: "",
  url: null,
  createdAt: "2026-09-01T10:00:00Z",
  lastMessageAt: null,
  createdBy: "Portal",
  ...patch,
});

const LIST = [
  masked({ id: "x2", email: "fern.otter804@mask.example", description: "Library", createdAt: "2026-08-01T10:00:00Z" }),
  masked({
    id: "x10",
    email: "shop.maple.otter482@mask.example",
    forDomain: "https://pixelparts.example",
    createdAt: "2026-09-20T10:00:00Z",
  }),
  masked({ id: "x9", email: "comet.fern217@mask.example", state: "pending", createdAt: "2026-09-20T10:00:00.000Z" }),
  masked({ id: "x3", email: "pebble.badger731@mask.example", state: "disabled", url: "https://deals.example.com/me" }),
  masked({ id: "x4", email: "cloud.lantern55@mask.example", state: "deleted" }),
];

describe("the list", () => {
  it("puts pending and enabled ones together as active", () => {
    expect(filterOf("pending")).toBe("active");
    expect(filterOf("enabled")).toBe("active");
    expect(filterOf("disabled")).toBe("disabled");
    expect(filterOf("deleted")).toBe("deleted");
    expect(countByFilter(LIST)).toEqual({ active: 3, disabled: 1, deleted: 1 });
  });

  it("shows the newest first, the later id first when made at the same moment", () => {
    expect(newestFirst(LIST).map((item) => item.id)).toEqual(["x10", "x9", "x4", "x3", "x2"]);
  });

  it("finds by address, description, site and link, within the chosen state", () => {
    expect(visibleMasked(LIST, "active", "").map((item) => item.id)).toEqual(["x10", "x9", "x2"]);
    expect(visibleMasked(LIST, "active", "  LIBRARY ").map((item) => item.id)).toEqual(["x2"]);
    expect(visibleMasked(LIST, "active", "pixelparts").map((item) => item.id)).toEqual(["x10"]);
    expect(visibleMasked(LIST, "active", "otter").map((item) => item.id)).toEqual(["x10", "x2"]);
    expect(visibleMasked(LIST, "disabled", "deals.example.com/me").map((item) => item.id)).toEqual(["x3"]);
    expect(visibleMasked(LIST, "deleted", "otter")).toEqual([]);
  });
});

describe("the site", () => {
  it("is kept as an origin, the way password managers write it", () => {
    expect(siteOrigin("shop.example.com")).toBe("https://shop.example.com");
    expect(siteOrigin("  https://Shop.Example.com/account?x=1 ")).toBe("https://shop.example.com");
    expect(siteOrigin("http://shop.example.com:8080/")).toBe("http://shop.example.com:8080");
    expect(siteOrigin("shop.example.com/login")).toBe("https://shop.example.com");
  });

  it("stays as typed when it isn't a web address", () => {
    expect(siteOrigin("")).toBe("");
    expect(siteOrigin("My bakery")).toBe("My bakery");
    expect(siteOrigin("ftp://files.example.com")).toBe("ftp://files.example.com");
  });

  it("is shown without its scheme", () => {
    expect(siteLabel("https://shop.example.com")).toBe("shop.example.com");
    expect(siteLabel("My bakery")).toBe("My bakery");
  });

  it("opens only web links", () => {
    expect(openableUrl("https://shop.example.com/me")).toBe("https://shop.example.com/me");
    expect(openableUrl("javascript:alert(1)")).toBeNull();
    expect(openableUrl("not a link")).toBeNull();
    expect(openableUrl(null)).toBeNull();
  });
});

describe("the form", () => {
  const form = { description: "Shop", forDomain: "shop.example.com", url: "", emailPrefix: "" };

  it("takes a prefix of a-z, 0-9 and _ up to 64, capitals as lower case", () => {
    expect(maskedProblems({ ...form, emailPrefix: "shop_2026" })).toEqual({});
    expect(maskedProblems({ ...form, emailPrefix: "Shop" })).toEqual({});
    expect(maskedProblems({ ...form, emailPrefix: "a".repeat(64) })).toEqual({});
    expect(maskedProblems({ ...form, emailPrefix: "a".repeat(65) })).toEqual({ emailPrefix: "prefix" });
    expect(maskedProblems({ ...form, emailPrefix: "shop-2026" })).toEqual({ emailPrefix: "prefix" });
    expect(maskedProblems({ ...form, emailPrefix: "shop.now" })).toEqual({ emailPrefix: "prefix" });
    expect(maskedProblems({ ...form, emailPrefix: "café" })).toEqual({ emailPrefix: "prefix" });
  });

  it("keeps to the server's limits", () => {
    expect(maskedProblems({ ...form, description: "x".repeat(201) })).toEqual({ description: "tooLong" });
    expect(maskedProblems({ ...form, description: "a\u0007b" })).toEqual({ description: "control" });
    expect(maskedProblems({ ...form, forDomain: `${"x".repeat(200)}.example` })).toEqual({ forDomain: "tooLong" });
    expect(maskedProblems({ ...form, url: "https://shop.example.com/my account" })).toEqual({ url: "spaces" });
    expect(maskedProblems({ ...form, url: `https://shop.example.com/${"x".repeat(2000)}` })).toEqual({
      url: "tooLong",
    });
  });

  it("hands the server trimmed values, the site as an origin and the prefix in lower case", () => {
    expect(
      maskedInput({ description: " Shop ", forDomain: "shop.example.com", url: " ", emailPrefix: " Shop " }),
    ).toEqual({ description: "Shop", forDomain: "https://shop.example.com", url: null, emailPrefix: "shop" });
    expect(maskedInput({ ...form, url: "https://shop.example.com/me" }, "mask.example")).toEqual({
      description: "Shop",
      forDomain: "https://shop.example.com",
      url: "https://shop.example.com/me",
      domain: "mask.example",
    });
  });
});
