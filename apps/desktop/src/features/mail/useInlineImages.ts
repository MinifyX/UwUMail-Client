import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import { backend } from "@/backend/backend";
import type { Message } from "@/backend/types";
import { normalizeContentId, referencedContentIds } from "@/lib/inlineImages";

/**
 * The embedded images a mail's HTML points at, as blob URLs by Content-ID. Blob URLs are already
 * allowed in the mail frame, so local files never need a wider Content-Security-Policy.
 * `shown` are the attachments that appear in the body now and don't need a tile.
 */
export function useInlineImages(message: Message) {
  const referenced = useMemo(() => referencedContentIds(message.bodyHtml), [message.bodyHtml]);
  const inline = message.attachments.filter(
    (attachment) => attachment.contentId && referenced.has(normalizeContentId(attachment.contentId)),
  );
  const results = useQueries({
    queries: inline.map((attachment) => ({
      queryKey: ["inlineImage", attachment.id],
      queryFn: async () => {
        const file = await backend().getAttachment(attachment.id);
        const blob = await (await fetch(file.url)).blob();
        return URL.createObjectURL(blob);
      },
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
    })),
  });

  const loaded = results.map((result) => result.data ?? "").join("|");
  return useMemo(() => {
    const urls = new Map<string, string>();
    const shown = new Set<string>();
    const found = loaded.split("|");
    inline.forEach((attachment, index) => {
      const url = found[index];
      if (!url || !attachment.contentId) return;
      urls.set(normalizeContentId(attachment.contentId), url);
      shown.add(attachment.id);
    });
    return { urls, shown };
    // The attachment list only changes with the message; `loaded` carries the results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, message.id]);
}
