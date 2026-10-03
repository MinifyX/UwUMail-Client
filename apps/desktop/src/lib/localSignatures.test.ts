import { describe, expect, it } from "vitest";
import type { AccountDomainSignatures, Identity, Signature } from "@/backend/types";
import { domainChange } from "./domainSignatures";
import {
  companyFooterForSender,
  deviceChange,
  deviceIdentities,
  deviceOverview,
  senderSignatures,
} from "./localSignatures";

const identity = (accountId: string, email: string, name = "Mini"): Identity => ({
  id: `${accountId}:${email}`,
  accountId,
  email,
  name,
  primary: false,
  fromServer: false,
});

const signature = (id: string, email: string, html: string, extra: Partial<Signature> = {}): Signature => ({
  id,
  email,
  name: id,
  html,
  forNew: true,
  forReplies: true,
  ...extra,
});

const labels = { domain: (domain: string) => `for ${domain}`, allDomains: "for all" };

/** A UwUMail account "u" whose server knows info@shop.example, with a mandatory footer there. */
const server: AccountDomainSignatures = {
  accountId: "u",
  overview: {
    state: "4",
    allDomains: null,
    domains: [
      {
        domain: "shop.example",
        addressCount: 1,
        signature: { text: "{name}", html: "" },
        company: { mode: "footer", text: "Shop GmbH", html: "" },
        source: "domain",
      },
    ],
    identities: [
      {
        id: "i1",
        name: "Mini",
        email: "info@shop.example",
        domain: "shop.example",
        signature: null,
        effective: { text: "Mini <b>", html: "" },
        source: "domain",
      },
    ],
  },
};

const identities = [
  identity("u", "info@shop.example"),
  // Typed in by hand on the same account; the server doesn't know it.
  identity("u", "extra@shop.example"),
  identity("g", "mini@mail.example"),
  identity("g", "team@mail.example", "Team"),
  identity("w", "mini@work.example"),
];

describe("device signatures per domain", () => {
  it("cover the addresses no server with signatures per domain knows", () => {
    expect(deviceIdentities(identities, [server]).map((entry) => entry.email)).toEqual([
      "extra@shop.example",
      "mini@mail.example",
      "team@mail.example",
      "mini@work.example",
    ]);
    expect(deviceIdentities(identities, undefined)).toHaveLength(5);
  });

  it("look like the server's overview, so the same editor works on them", () => {
    const local = deviceIdentities(identities, [server]);
    const signatures = [
      signature("d", "@mail.example", "<p>{name} · {domain}</p>"),
      signature("a", "*", "<p>Alle</p>"),
      signature("own", "team@mail.example", "<p>Team</p>"),
    ];
    const overview = deviceOverview(local, signatures);
    expect(overview.domains.map((entry) => [entry.domain, entry.addressCount, entry.source])).toEqual([
      ["mail.example", 2, "domain"],
      ["shop.example", 1, "allDomains"],
      ["work.example", 1, "allDomains"],
    ]);
    expect(overview.allDomains?.text).toBe("Alle");
    const mini = overview.identities.find((entry) => entry.email === "mini@mail.example")!;
    expect(mini.effective.html).toBe("<p>Mini · mail.example</p>");
    expect(overview.identities.find((entry) => entry.email === "team@mail.example")?.source).toBe("identity");
    // A change of a domain signature gives a new state, so the editor starts over.
    const changed = deviceOverview(local, [{ ...signatures[0]!, html: "<p>Neu</p>" }, ...signatures.slice(1)]);
    expect(changed.state).not.toBe(overview.state);
  });

  it("turn a change into signatures to save and delete", () => {
    const signatures = [signature("d", "@mail.example", "<p>Alt</p>"), signature("w", "@work.example", "<p>W</p>")];
    const overview = deviceOverview(deviceIdentities(identities, [server]), signatures);
    const value = { text: "Neu", html: "<p>Neu</p>" };

    expect(deviceChange(domainChange(overview, ["mail.example", "shop.example"], value), signatures)).toEqual({
      save: [
        { id: "d", email: "@mail.example", name: "", html: "<p>Neu</p>", forNew: true, forReplies: true },
        { id: "", email: "@shop.example", name: "", html: "<p>Neu</p>", forNew: true, forReplies: true },
      ],
      remove: [],
    });
    // "All domains" stands alone and replaces the domains' own ones.
    const all = deviceChange(domainChange(overview, ["*"], { text: "Hallo", html: "" }), signatures);
    expect(all.save).toEqual([{ id: "", email: "*", name: "", html: "<p>Hallo</p>", forNew: true, forReplies: true }]);
    expect(all.remove.sort()).toEqual(["d", "w"]);
    expect(deviceChange(domainChange(overview, ["work.example"], null), signatures)).toEqual({
      save: [],
      remove: ["w"],
    });
  });
});

describe("what the composer offers", () => {
  const signatures = [
    signature("own", "TEAM@mail.example", "<p>{name}</p>", { name: "Kurz", forNew: false }),
    signature("d", "@mail.example", "<p>{name} @ {domain}</p>"),
    signature("a", "*", "<p>Alle {adresse}</p>"),
    signature("gone", "old@gone.example", "<p>Alt</p>"),
  ];
  const offered = senderSignatures(identities, signatures, [server], labels);
  const forAddress = (email: string) => offered.filter((entry) => entry.email.toLowerCase() === email);

  it("keeps own device signatures first, with the placeholders filled", () => {
    expect(forAddress("team@mail.example")).toEqual([{ ...signatures[0], html: "<p>Team</p>" }]);
    // Of an address not set up here: as it is.
    expect(forAddress("old@gone.example")).toEqual([signatures[3]]);
  });

  it("takes the server's signature for its addresses, and only that", () => {
    expect(forAddress("info@shop.example")).toEqual([
      expect.objectContaining({ id: "server:u:i1", name: "for shop.example", html: "<p>Mini &lt;b&gt;</p>" }),
    ]);
    // Without a server signature nothing on the device stands in.
    const empty = structuredClone(server);
    empty.overview.identities[0]!.effective = { text: "", html: "" };
    expect(senderSignatures(identities, signatures, [empty], labels).some((s) => s.email === "info@shop.example")).toBe(
      false,
    );
  });

  it("falls back to the domain's, then every domain's device signature", () => {
    expect(forAddress("mini@mail.example")).toEqual([
      expect.objectContaining({ name: "for mail.example", html: "<p>Mini @ mail.example</p>", forNew: true }),
    ]);
    expect(forAddress("mini@work.example")).toEqual([
      expect.objectContaining({ name: "for all", html: "<p>Alle mini@work.example</p>" }),
    ]);
    // The hand-typed address of the UwUMail account isn't the server's: the device's apply.
    expect(forAddress("extra@shop.example")).toEqual([expect.objectContaining({ name: "for all" })]);
    expect(new Set(offered.map((entry) => entry.id)).size).toBe(offered.length);
  });

  it("escapes names in the HTML it fills in", () => {
    const evil = [identity("g", "x@mail.example", '<img src=x onerror="alert(1)">')];
    const [only] = senderSignatures(evil, [signature("d", "@mail.example", "<p>{name}</p>")], undefined, labels);
    expect(only?.html).toBe("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>");
  });
});

describe("the company footer note", () => {
  it("shows for the server's addresses on a domain with a mandatory footer", () => {
    expect(companyFooterForSender([server], "u", "INFO@shop.example")).toEqual({ text: "Shop GmbH", html: "" });
    expect(companyFooterForSender([server], "g", "info@shop.example")).toBeNull();
    expect(companyFooterForSender([server], "u", "extra@shop.example")).toBeNull();
    expect(companyFooterForSender(undefined, "u", "info@shop.example")).toBeNull();
  });
});
