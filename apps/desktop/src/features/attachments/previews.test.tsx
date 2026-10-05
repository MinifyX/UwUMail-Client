import "@/test/dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttachmentContent } from "@/backend/types";
import { i18n } from "@/i18n";
import { AttachmentPreview, looksLikePdf } from "./previews";

const PDF = "%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n";
const HTML = "<!doctype html><script>alert(document.cookie)</script>";

function file(filename: string, url = "blob:own/download"): AttachmentContent {
  return { url, filename, mimeType: "application/pdf", size: 64, dangerous: false };
}

const ASSET = "http://asset.localhost/attachments/a1/Rechnung.pdf";

/** The attachment comes back as octet-stream, as senders often label PDFs. */
function serve(text: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(text, { headers: { "content-type": "application/octet-stream" } })),
  );
}

describe("PDF preview", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows a PDF that arrives as octet-stream, as a copy typed application/pdf", async () => {
    serve(PDF);
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:own/pdf");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { unmount } = render(<AttachmentPreview file={file("Rechnung.pdf")} kind="pdf" />);
    const frame = await screen.findByTitle("Rechnung.pdf");
    expect(frame.getAttribute("src")).toBe("blob:own/pdf");
    const blob = create.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("application/pdf");
    expect(looksLikePdf(new Uint8Array(await blob.arrayBuffer()))).toBe(true);
    unmount();
    expect(revoke).toHaveBeenCalledWith("blob:own/pdf");
  });

  it("never frames a web page that is named like a PDF", async () => {
    serve(HTML);
    const create = vi.spyOn(URL, "createObjectURL");
    render(<AttachmentPreview file={file("invoice.pdf")} kind="pdf" />);
    expect(await screen.findByText(/This file says it's a PDF but isn't one/)).toBeTruthy();
    expect(screen.queryByTitle("invoice.pdf")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("in the app frames the attachment file server's own address, never a blob copy (RD-1/RD-3)", async () => {
    serve(PDF);
    const create = vi.spyOn(URL, "createObjectURL");
    render(<AttachmentPreview file={file("Rechnung.pdf", ASSET)} kind="pdf" />);
    const frame = await screen.findByTitle("Rechnung.pdf");
    expect(frame.getAttribute("src")).toBe(ASSET);
    expect(create).not.toHaveBeenCalled();
  });

  it("in the app doesn't frame a PDF whose header comes after other bytes", async () => {
    serve(`junk\n${PDF}`);
    const create = vi.spyOn(URL, "createObjectURL");
    render(<AttachmentPreview file={file("odd.pdf", ASSET)} kind="pdf" />);
    expect(await screen.findByText(/This PDF can't be shown here/)).toBeTruthy();
    expect(screen.queryByTitle("odd.pdf")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
