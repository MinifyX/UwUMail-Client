import { describe, expect, it } from "vitest";
import { isSyncable } from "./settingsSync";
import { cleanTemplateName, fillHtml, fillText, newTemplateId, templateHtml, templateValues } from "./templates";

describe("templates", () => {
  it("makes ids the server takes", () => {
    const id = newTemplateId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newTemplateId()).not.toBe(id);
    expect(isSyncable(`template:${id}`, { name: "x", subject: "", html: "" })).toBe(true);
  });

  it("fills placeholders from the first recipient and the sender", () => {
    const values = templateValues({
      to: [{ name: "Leni Sommer", email: "leni@example.com" }, { email: "noah@example.com" }],
      myName: "Mini ",
      language: "en",
      now: new Date(2026, 9, 20),
    });
    expect(values).toEqual({ firstName: "Leni", name: "Leni Sommer", date: "October 20, 2026", myName: "Mini" });
    expect(fillText("Hi {firstName}, {unknown} {date}", values)).toBe("Hi Leni, {unknown} October 20, 2026");
  });

  it("falls back to the address and escapes values in HTML", () => {
    const values = templateValues({ to: [{ email: "noah@example.com" }], myName: "<b>Mini</b>", language: "de" });
    expect(values.name).toBe("noah");
    expect(fillHtml("<p>{myName} an {name}</p>", values)).toBe("<p>&lt;b&gt;Mini&lt;/b&gt; an noah</p>");
    expect(templateValues({ to: [], myName: "", language: "de" }).firstName).toBe("");
  });

  it("cleans names", () => {
    expect(cleanTemplateName(" a\tb ")).toBe("a b");
    expect([...cleanTemplateName("x".repeat(200))]).toHaveLength(100);
  });
});

describe("template markup in a draft", () => {
  const values = { firstName: "<b>Leni</b>", name: "Leni", date: "", myName: "Mini" };

  it("is cleaned like a signature and keeps no app markers", () => {
    const html = templateHtml(
      '<p data-uwu-signature="1" onclick="x()">Hi {firstName}</p><img src="x" onerror="x()"><script>x()</script>',
      values,
    );
    expect(html).toContain("Hi &lt;b&gt;Leni&lt;/b&gt;");
    expect(html).not.toMatch(/data-uwu|onclick|onerror|<script/i);
  });
});
