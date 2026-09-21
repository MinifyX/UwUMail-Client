import { describe, expect, it } from "vitest";
import { parseMailto } from "./mailto";

describe("parseMailto", () => {
  it("reads recipients, subject and body", () => {
    expect(
      parseMailto(
        "mailto:leni@example.org,noah@example.org?cc=mia@example.org&bcc=x@example.org&subject=Hallo%20Leni&body=Zeile%201%0D%0AZeile%202",
      ),
    ).toEqual({
      to: [{ email: "leni@example.org" }, { email: "noah@example.org" }],
      cc: [{ email: "mia@example.org" }],
      bcc: [{ email: "x@example.org" }],
      subject: "Hallo Leni",
      body: "Zeile 1\nZeile 2",
    });
  });

  it("handles odd links", () => {
    expect(parseMailto("MAILTO:?to=a%40b.example")?.to).toEqual([{ email: "a@b.example" }]);
    expect(parseMailto("mailto:not an address")?.to).toEqual([]);
    expect(parseMailto("mailto:%E0%A4%A")?.to).toEqual([]);
    expect(parseMailto("https://example.org")).toBeNull();
    expect(parseMailto("nonsense")).toBeNull();
  });
});
