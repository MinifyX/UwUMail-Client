import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { applyUiFont, FONT_STACKS } from "@/lib/fonts";
import { SYNCED_FIELDS } from "@/lib/settingsSync";
import { DEFAULT_SETTINGS, useSettings } from "@/state/settings";
import { FontPicker, SenderFontsSetting } from "./FontPicker";

describe("font picker", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("de");
  });
  afterEach(() => {
    cleanup();
    useSettings.setState({ font: DEFAULT_SETTINGS.font, senderFonts: DEFAULT_SETTINGS.senderFonts });
  });

  it("shows every choice in its own font, UwU Sans picked", () => {
    render(<FontPicker />);
    const options = screen.getAllByRole("radio");
    expect(options.map((option) => option.querySelector("span")!.textContent)).toEqual([
      "UwU Sans",
      "Rubik",
      "DM Sans",
      "Systemschrift",
    ]);
    expect(options[1]!.style.fontFamily).toContain("Rubik Variable");
    expect(options[0]!.getAttribute("aria-checked")).toBe("true");
  });

  it("switches the font", () => {
    render(<FontPicker />);
    fireEvent.click(screen.getByRole("radio", { name: /DM Sans/ }));
    expect(useSettings.getState().font).toBe("dmsans");
    expect(screen.getByRole("radio", { name: /DM Sans/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("switches what happens to the sender's fonts", () => {
    render(<SenderFontsSetting />);
    fireEvent.click(screen.getByRole("radio", { name: "Wie vom Absender" }));
    expect(useSettings.getState().senderFonts).toBe("keep");
  });

  it("puts the font on the whole interface", () => {
    const root = document.createElement("div");
    applyUiFont("system", root);
    expect(root.style.getPropertyValue("--font-ui")).toBe(FONT_STACKS.system);
    expect(root.dataset.font).toBe("system");
  });

  it("stays on this device", () => {
    expect(SYNCED_FIELDS).not.toContain("font");
    expect(SYNCED_FIELDS).not.toContain("senderFonts");
  });
});
