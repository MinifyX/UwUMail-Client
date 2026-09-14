import { ChevronLeft, ChevronRight, Download, ExternalLink, FileQuestion, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { backend } from "@/backend/backend";
import type { Address, Attachment } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { useT } from "@/i18n";
import { attachmentKind, isDangerous } from "@/lib/attachments";
import { displayName, formatSize } from "@/lib/format";
import { useAttachment } from "@/lib/queries";
import { toast } from "@/state/toasts";
import { AttachmentPreview } from "./previews";

interface AttachmentViewerProps {
  attachments: Attachment[];
  index: number | null;
  sender: Address;
  onIndexChange: (index: number | null) => void;
}

export function AttachmentViewer({ attachments, index, sender, onIndexChange }: AttachmentViewerProps) {
  const open = index !== null && attachments[index] !== undefined;
  return (
    <Dialog open={open} onClose={() => onIndexChange(null)} width="viewer">
      {open && (
        <ViewerBody
          key={attachments[index]!.id}
          attachments={attachments}
          index={index}
          sender={sender}
          onIndexChange={onIndexChange}
        />
      )}
    </Dialog>
  );
}

function ViewerBody({ attachments, index, sender, onIndexChange }: AttachmentViewerProps & { index: number }) {
  const { t, i18n } = useT();
  const attachment = attachments[index]!;
  const kind = attachmentKind(attachment.filename, attachment.mimeType);
  const dangerous = isDangerous(attachment.filename);
  const needsFile = kind !== "other";
  const { data: file, error, isPending } = useAttachment(needsFile ? attachment.id : null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"open" | "save" | null>(null);
  const count = attachments.length;

  const go = (step: 1 | -1) => onIndexChange((index + step + count) % count);

  const run = async (action: "open" | "save", confirmed = false) => {
    if (action === "open" && dangerous && !confirmed) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(action);
    try {
      if (action === "open") await backend().openAttachment(attachment.id, confirmed);
      else if (await backend().saveAttachment(attachment.id, attachment.filename)) {
        toast(t("attachment.saved", { name: attachment.filename }), "success");
      }
    } catch (reason) {
      toast(t("attachment.failed", { reason: reason instanceof Error ? reason.message : String(reason) }), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(event) => {
        if (count > 1 && event.key === "ArrowRight") go(1);
        if (count > 1 && event.key === "ArrowLeft") go(-1);
      }}
    >
      <header className="flex items-center gap-2 border-b border-hairline py-2 pr-2 pl-5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold">{attachment.filename}</p>
          <p className="text-[12px] text-muted">
            {formatSize(attachment.size, i18n.language)}
            {count > 1 && ` · ${t("attachment.counter", { current: index + 1, total: count })}`}
          </p>
        </div>
        {count > 1 && (
          <>
            <IconButton icon={ChevronLeft} label={t("attachment.previous")} onClick={() => go(-1)} />
            <IconButton icon={ChevronRight} label={t("attachment.next")} onClick={() => go(1)} />
          </>
        )}
        <Button icon={ExternalLink} size="sm" busy={busy === "open"} onClick={() => void run("open")}>
          {t("attachment.open")}
        </Button>
        <Button icon={Download} size="sm" busy={busy === "save"} onClick={() => void run("save")}>
          {t("attachment.save")}
        </Button>
        <IconButton icon={X} label={t("common.close")} onClick={() => onIndexChange(null)} />
      </header>

      {dangerous && (
        <div
          role={confirming ? "alertdialog" : "note"}
          className="border-b border-danger/30 bg-danger-tint px-5 py-3 text-danger"
        >
          <p className="flex items-center gap-2 text-[14px] font-bold">
            <ShieldAlert className="size-5 shrink-0" aria-hidden />
            {t("attachment.dangerTitle")}
          </p>
          <p className="pt-1 pl-7 text-[13px]">
            {t("attachment.dangerBody", {
              name: attachment.filename,
              sender: `${displayName(sender)} <${sender.email}>`,
            })}
          </p>
          {confirming && (
            <div className="flex flex-wrap gap-2 pt-3 pl-7">
              <Button size="sm" variant="primary" autoFocus onClick={() => setConfirming(false)}>
                {t("attachment.dangerCancel")}
              </Button>
              <Button size="sm" variant="danger" onClick={() => void run("open", true)}>
                {t("attachment.dangerOpen")}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 bg-canvas">
        {!needsFile ? (
          <EmptyState
            icon={FileQuestion}
            title={t("attachment.noPreview")}
            body={t("attachment.noPreviewBody")}
            className="h-full"
          />
        ) : isPending ? (
          <p className="grid h-full place-items-center text-[13px] text-muted">{t("attachment.loading")}</p>
        ) : error || !file ? (
          <p className="grid h-full place-items-center px-6 text-center text-[13px] text-danger">
            {t("attachment.failed", { reason: error instanceof Error ? error.message : "" })}
          </p>
        ) : (
          <AttachmentPreview file={file} kind={kind} />
        )}
      </div>
    </div>
  );
}
