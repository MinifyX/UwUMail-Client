import { afterEach, describe, expect, it, vi } from "vitest";
import type { DragEvent } from "react";
import { quotableHtml } from "@/lib/safeHtml";
import { insertDroppedHtml } from "./droppedHtml";

function drop(data: Record<string, string>, files: File[] = []) {
  const editor = document.createElement("div");
  document.body.append(editor);
  return {
    preventDefault: vi.fn(),
    clientX: 0,
    clientY: 0,
    currentTarget: editor,
    dataTransfer: { getData: (type: string) => data[type] ?? "", files },
  } as unknown as DragEvent<HTMLElement> & { preventDefault: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("markup dropped into an editor", () => {
  it("is cleaned like pasted markup, so a remote picture never loads here", () => {
    const inserted: string[] = [];
    document.execCommand = (_command: string, _ui?: boolean, value?: string) => {
      inserted.push(value ?? "");
      return true;
    };
    const event = drop({ "text/html": `<p>Hi<img src="https://tracker.example/pixel.gif"></p>` });
    expect(insertDroppedHtml(event, quotableHtml)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(inserted).toEqual(["<p>Hi</p>"]);
  });

  it("leaves plain text and files to the browser", () => {
    const text = drop({ "text/plain": "Hi" });
    expect(insertDroppedHtml(text, quotableHtml)).toBe(false);
    expect(text.preventDefault).not.toHaveBeenCalled();
    const file = drop({ "text/html": "<p>x</p>" }, [new File(["x"], "x.png", { type: "image/png" })]);
    expect(insertDroppedHtml(file, quotableHtml)).toBe(false);
  });
});
