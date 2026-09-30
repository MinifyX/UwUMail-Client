import { describe, expect, it } from "vitest";
import type { AssistLabel } from "@/backend/types";
import { groupByLabel, labelGroups, labelTerm, matchesLabels, splitLabelSearch, type LabelEntry } from "./labelFilter";

const label = (name: string, keyword: string): AssistLabel => ({
  id: keyword,
  name,
  description: "",
  keyword,
  color: null,
});
const directory: LabelEntry[] = [
  { scope: "uwu", accountIds: ["uwu"], label: label("Rechnungen", "rechnungen") },
  { scope: "device", accountIds: ["gmail", "imap"], label: label("Rechnungen", "rechnungen") },
  { scope: "device", accountIds: ["gmail", "imap"], label: label("Zwei Worte", "zwei-worte") },
];

describe("splitLabelSearch", () => {
  it("takes label terms out and keeps the rest", () => {
    expect(splitLabelSearch("label:Rechnungen amazon")).toEqual({ text: "amazon", names: ["Rechnungen"] });
    expect(splitLabelSearch('from mia label:"Zwei Worte"')).toEqual({ text: "from mia", names: ["Zwei Worte"] });
    expect(splitLabelSearch("LABELS:a label:b")).toEqual({ text: "", names: ["a", "b"] });
  });

  it("leaves words that only contain label alone", () => {
    expect(splitLabelSearch("mylabel:x relabel")).toEqual({ text: "mylabel:x relabel", names: [] });
  });
});

describe("labelGroups", () => {
  it("finds a name in every scope, by name or keyword", () => {
    const [group] = labelGroups(["rechnungen"], directory);
    expect(group).toEqual([
      { keyword: "rechnungen", accountIds: ["uwu"] },
      { keyword: "rechnungen", accountIds: ["gmail", "imap"] },
    ]);
    expect(labelGroups(["zwei-worte"], directory)[0]).toHaveLength(1);
  });

  it("matches nothing for an unknown name", () => {
    expect(labelGroups(["nope"], directory)).toEqual([[]]);
    expect(matchesLabels({ accountId: "uwu", keywords: ["rechnungen"] }, [[]])).toBe(false);
  });
});

describe("matchesLabels", () => {
  it("needs the keyword on mail of the label's mailboxes", () => {
    const groups = labelGroups(["Zwei Worte"], directory);
    expect(matchesLabels({ accountId: "gmail", keywords: ["zwei-worte"] }, groups)).toBe(true);
    expect(matchesLabels({ accountId: "uwu", keywords: ["zwei-worte"] }, groups)).toBe(false);
    expect(matchesLabels({ accountId: "gmail", keywords: [] }, [])).toBe(true);
  });
});

it("quotes names with spaces", () => {
  expect(labelTerm("Zwei Worte")).toBe('label:"Zwei Worte"');
  expect(labelTerm("Reisen")).toBe("label:Reisen");
});

describe("groupByLabel", () => {
  it("puts each conversation under its first label and the rest last", () => {
    const threads = [
      { id: "a", accountIds: ["gmail"], keywords: ["zwei-worte", "rechnungen"] },
      { id: "b", accountIds: ["uwu"], keywords: ["rechnungen"] },
      { id: "c", accountIds: ["uwu"], keywords: ["zwei-worte"] },
      { id: "d", accountIds: ["gmail"] },
    ];
    const sections = groupByLabel(threads, directory);
    expect(sections.map((s) => [s.entry?.scope ?? null, s.items.map((t) => t.id)])).toEqual([
      ["uwu", ["b"]],
      ["device", ["a"]],
      [null, ["c", "d"]],
    ]);
  });
});
