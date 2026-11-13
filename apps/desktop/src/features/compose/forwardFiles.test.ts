import "@/test/dom";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Message, OutgoingAttachment } from "@/backend/types";
import { useForwardedFiles } from "./forwardFiles";

const invoice: OutgoingAttachment = {
  filename: "rechnung.pdf",
  mimeType: "application/pdf",
  size: 3,
  source: { kind: "base64", data: "UERG" },
};
const fake = { messageAttachments: vi.fn((_id: string) => Promise.resolve([invoice])) };

vi.mock("@/backend/backend", async (original) => ({
  ...(await original<typeof import("@/backend/backend")>()),
  backend: () => fake,
}));

describe("forwarding", () => {
  it("starts with the original mail's files, and only for a new forward", async () => {
    const source = { id: "m1" } as Message;
    const add = vi.fn();
    const { result } = renderHook(() => useForwardedFiles({ key: 1, mode: "forward", source }, add));
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
    expect(fake.messageAttachments).toHaveBeenCalledWith("m1");
    expect(add).toHaveBeenCalledWith([invoice]);

    fake.messageAttachments.mockClear();
    const reply = renderHook(() => useForwardedFiles({ key: 2, mode: "reply", source }, vi.fn()));
    expect(reply.result.current).toBe(false);
    expect(fake.messageAttachments).not.toHaveBeenCalled();
  });
});
