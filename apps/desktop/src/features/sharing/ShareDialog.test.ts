import { describe, expect, it } from "vitest";
import { matchingPeople } from "./ShareDialog";

const people = [
  { id: "p3", name: "Mini", email: "mini@example.org" },
  { id: "p5", name: "Kai Kralle", email: "kai@example.org" },
  { id: "p6", name: "Karla", email: "karla@example.net" },
];

describe("picking somebody to share with", () => {
  it("finds people by name or address", () => {
    expect(matchingPeople(people, "ka", new Set()).map((p) => p.id)).toEqual(["p5", "p6"]);
    expect(matchingPeople(people, "EXAMPLE.NET", new Set()).map((p) => p.id)).toEqual(["p6"]);
  });

  it("leaves out who has it already", () => {
    expect(matchingPeople(people, "", new Set(["p3"])).map((p) => p.id)).toEqual(["p5", "p6"]);
  });
});
