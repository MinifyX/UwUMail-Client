import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { useToasts } from "@/state/toasts";
import { groupCode } from "./format";
import type { VerificationCode } from "./types";
import { ReaderCodeHint, VerificationCodeBar } from "./VerificationCodeBar";

const NOW = Date.parse("2026-11-02T10:00:00Z");

const code = (extra: Partial<VerificationCode> = {}): VerificationCode => ({
  id: "vc-1",
  emailId: "m1",
  kind: "otp",
  code: "482913",
  origin: "bank.example",
  sender: "Bank Beispiel",
  purpose: "login",
  source: "header",
  autofill: true,
  expiresAt: new Date(NOW + 65_000).toISOString(),
  ...extra,
});

describe("VerificationCodeBar", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useToasts.setState({ toasts: [] });
  });

  it("renders nothing without a working code", () => {
    const { container } = render(<VerificationCodeBar codes={[]} />);
    expect(container.innerHTML).toBe("");
    const expired = code({ expiresAt: new Date(NOW - 1000).toISOString() });
    const again = render(<VerificationCodeBar codes={[expired]} />);
    expect(again.container.innerHTML).toBe("");
  });

  it("counts down and drops the code once it expired", () => {
    render(<VerificationCodeBar codes={[code()]} />);
    expect(screen.getByRole("list", { name: "Sign-in codes" }).textContent).toContain(groupCode("482913"));
    screen.getByText("1:05 left");
    act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByText("0:59 left").className).toContain("text-warning-ink");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole("list", { name: "Sign-in codes" })).toBeNull();
  });

  it("marks codes read from the text as not filled in", () => {
    render(<VerificationCodeBar codes={[code(), code({ id: "vc-2", source: "heuristic", autofill: false })]} />);
    expect(screen.getAllByText("No autofill")).toHaveLength(1);
    expect(screen.getAllByRole("listitem")[1]!.className).toContain("border-dashed");
  });

  it("offers to open a sign-in link instead of copying it", () => {
    const link = code({ kind: "link", code: undefined, url: "https://forum.example.net/login", autofill: false });
    render(<VerificationCodeBar codes={[link]} />);
    expect(screen.getByRole("button", { name: "Open sign-in link for bank.example" }).textContent).toBe("Open");
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
  });

  it("copies the code to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<VerificationCodeBar codes={[code()]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Copy code ${groupCode("482913")}` }));
    });
    expect(writeText).toHaveBeenCalledWith("482913");
    expect(useToasts.getState().toasts.at(-1)?.message).toBe(`Code ${groupCode("482913")} copied`);
  });

  it("says in the reader when a code has expired", () => {
    render(<ReaderCodeHint code={code({ expiresAt: new Date(NOW - 1).toISOString() })} />);
    screen.getByText("This code has expired.");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
