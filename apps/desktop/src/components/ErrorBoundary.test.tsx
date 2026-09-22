import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { ErrorBoundary } from "./ErrorBoundary";

function Broken(): never {
  throw new Error("kaputt");
}

describe("ErrorBoundary", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("de");
  });

  // Vitest runs without globals here, so the automatic cleanup is not registered.
  afterEach(cleanup);

  it("shows a way back instead of an empty window when a part throws", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toContain("kaputt");
    expect(screen.getByRole("button", { name: "Neu laden" })).toBeTruthy();
    errors.mockRestore();
  });
});
