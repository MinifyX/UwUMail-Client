import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LinkAddress } from "./LinkWarning";

describe("LinkAddress in the status line", () => {
  it("keeps the registrable domain in a part of its own that never shrinks", () => {
    const { container } = render(
      <LinkAddress href="https://www.bank.example.login.secure.evil.example/path?x=1" compact />,
    );
    const parts = [...container.firstElementChild!.children].map((part) => ({
      text: part.textContent,
      shrinks: !part.className.includes("shrink-0"),
    }));
    expect(parts).toEqual([
      { text: "https://", shrinks: false },
      { text: "www.bank.example.login.secure.", shrinks: true },
      { text: "evil.example", shrinks: false },
      { text: "", shrinks: false },
      { text: "/path?x=1", shrinks: true },
    ]);
  });
});
