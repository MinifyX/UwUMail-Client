import { useEffect, useState } from "react";
import { backend } from "@/backend/backend";
import type { OutgoingAttachment } from "@/backend/types";
import { translate } from "@/i18n";
import { toast } from "@/state/toasts";
import type { ComposeRequest } from "@/state/ui";

/**
 * A new forward brings the original mail's files along (they can be removed before sending).
 * Returns true while they are still loading, so the mail isn't sent without them.
 */
export function useForwardedFiles(request: ComposeRequest, add: (files: OutgoingAttachment[]) => void) {
  const source = request.mode === "forward" && !request.restore ? request.source?.id : undefined;
  const [loading, setLoading] = useState(source !== undefined);
  useEffect(() => {
    if (source === undefined) return;
    let cancelled = false;
    backend()
      .messageAttachments(source)
      .then(
        (files) => {
          if (!cancelled && files.length > 0) add(files);
        },
        (reason: unknown) => {
          if (cancelled) return;
          const message = reason instanceof Error ? reason.message : String(reason);
          toast(translate("toast.forwardFilesFailed", { reason: message }), "error");
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Once per compose request: the component is keyed by it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);
  return loading;
}
