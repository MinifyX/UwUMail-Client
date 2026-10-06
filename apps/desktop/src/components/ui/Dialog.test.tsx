import "@/test/dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppLock } from "@/state/lock";
import { Dialog } from "./Dialog";

describe("Dialog", () => {
  afterEach(cleanup);

  it("closes only the inner one on Escape when a dialog is opened from another", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Dialog open onClose={outer} title="Außen">
        <Dialog open onClose={inner} title="Innen">
          <p>Sicher?</p>
        </Dialog>
      </Dialog>,
    );
    const dialog = screen.getByText("Sicher?").closest("dialog")!;
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("waits while the app lock covers the window", () => {
    useAppLock.setState({ locked: true });
    render(
      <Dialog open onClose={() => {}} title="Einstellungen">
        <p>Inhalt</p>
      </Dialog>,
    );
    expect(screen.getByText("Inhalt").closest("dialog")!.open).toBe(false);
    useAppLock.setState({ locked: false });
  });
});
