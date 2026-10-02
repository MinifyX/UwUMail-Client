import { describe, expect, it } from "vitest";
import { fontVariables, rewriteElementFonts, rewriteFontDeclarations, rewriteFontValue } from "./mailFonts";

describe("sender fonts in HTML mail", () => {
  it("lets the frame swap serif fonts and the serif keyword", () => {
    expect(rewriteFontValue('"Times New Roman", Times, serif')).toBe(
      'var(--uwu-serif, "Times New Roman"), var(--uwu-serif, Times), var(--uwu-serif, serif)',
    );
    expect(rewriteFontValue("Georgia,serif")).toBe("var(--uwu-serif, Georgia), var(--uwu-serif, serif)");
    expect(rewriteFontValue("'Palatino Linotype'")).toBe("var(--uwu-serif, 'Palatino Linotype'), var(--uwu-font)");
  });

  it("never touches sans-serif as if it were serif", () => {
    const out = rewriteFontValue("Arial, sans-serif");
    expect(out).toBe("Arial, var(--uwu-sans, sans-serif)");
    expect(out).not.toContain("--uwu-serif");
  });

  it("puts our font behind fonts that may not be installed", () => {
    expect(rewriteFontValue("Calibri")).toBe("Calibri, var(--uwu-font)");
    expect(rewriteFontValue('Aptos, "Segoe UI"')).toBe('Aptos, "Segoe UI", var(--uwu-font)');
    // a generic family already ends the list: the frame decides about it instead
    expect(rewriteFontValue("Calibri, cursive")).toBe("Calibri, cursive");
  });

  it("leaves monospace, keywords and odd values alone", () => {
    for (const value of [
      "monospace",
      '"Courier New", Courier, monospace',
      "Consolas",
      "inherit",
      "var(--x)",
      "",
      "Arial,,serif",
    ]) {
      expect(rewriteFontValue(value)).toBe(value);
    }
  });

  it("keeps !important and the rest of a font shorthand", () => {
    expect(rewriteFontValue("Georgia !important")).toBe("var(--uwu-serif, Georgia), var(--uwu-font) !important");
    expect(rewriteFontValue("bold 14px/1.4 Georgia, serif", true)).toBe(
      "bold 14px/1.4 var(--uwu-serif, Georgia), var(--uwu-serif, serif)",
    );
    expect(rewriteFontValue("italic small-caps 12pt Calibri", true)).toBe(
      "italic small-caps 12pt Calibri, var(--uwu-font)",
    );
    expect(rewriteFontValue("12px Courier New, monospace", true)).toBe("12px Courier New, monospace");
    expect(rewriteFontValue("caption", true)).toBe("caption");
  });

  it("rewrites declarations in style blocks and attributes, but not @font-face rules", () => {
    const css =
      '@font-face{font-family:"Georgia";src:url(data:font/woff2;base64,AA)} body{font-size:14px;font-family:Georgia} p{font:12px serif;color:red}';
    const out = rewriteFontDeclarations(css);
    expect(out).toContain('@font-face{font-family:"Georgia";src:url(data:font/woff2;base64,AA)}');
    expect(out).toContain("font-size:14px;font-family:var(--uwu-serif, Georgia), var(--uwu-font)}");
    expect(out).toContain("font:12px var(--uwu-serif, serif);color:red");
    expect(rewriteFontDeclarations("color:red; font-family: Cambria")).toBe(
      "color:red; font-family: var(--uwu-serif, Cambria), var(--uwu-font)",
    );
  });

  it("turns <font face> into a style the frame can steer", () => {
    const doc = new DOMParser().parseFromString(
      '<font face="Times New Roman" style="color:red">Hi</font><font face="Courier New">x</font>',
      "text/html",
    );
    const [serif, mono] = [...doc.querySelectorAll("font")];
    rewriteElementFonts(serif!);
    rewriteElementFonts(mono!);
    expect(serif!.getAttribute("style")).toBe(
      "font-family:var(--uwu-serif, Times New Roman), var(--uwu-font);color:red",
    );
    expect(mono!.hasAttribute("style")).toBe(false);
  });

  it("sets the variables for both choices", () => {
    expect(fontVariables("uwu", "replace")).toBe(
      '--uwu-font:"uwu-mail-font", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif;--uwu-serif:var(--uwu-font);--uwu-sans:var(--uwu-font)',
    );
    // Keeping the sender's fonts: --uwu-serif stays undefined, so var() falls back to what was written.
    expect(fontVariables("system", "keep")).toMatch(/^--uwu-font:system-ui, [^;]*$/);
  });
});
