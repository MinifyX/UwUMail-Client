import clsx from "clsx";
import {
  CalendarDays,
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Paperclip,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { Address, Attachment } from "@/backend/types";
import { useT } from "@/i18n";
import { attachmentKind, isDangerous, type AttachmentKind } from "@/lib/attachments";
import { formatSize } from "@/lib/format";
import { useAttachment } from "@/lib/queries";
import { AttachmentViewer } from "./AttachmentViewer";

const ICONS: Record<AttachmentKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  text: FileCode,
  json: FileCode,
  csv: FileSpreadsheet,
  audio: FileAudio,
  video: FileVideo,
  calendar: CalendarDays,
  contact: UserRound,
  other: File,
};

/** Images up to this size get a thumbnail right away; bigger ones load when opened. */
const THUMBNAIL_LIMIT = 15 * 1024 * 1024;

function Thumbnail({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const { i18n } = useT();
  const { data } = useAttachment(attachment.id);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={attachment.filename}
      className="group relative block size-28 overflow-hidden rounded-xl border border-line bg-canvas hover:border-pink"
    >
      {data ? (
        <img
          src={data.url}
          alt={attachment.filename}
          className="size-full object-cover transition-transform group-hover:scale-105"
        />
      ) : (
        <FileImage className="absolute inset-0 m-auto size-6 text-muted" aria-hidden />
      )}
      <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent px-2 pt-4 pb-1 text-left text-[11px] font-semibold text-white">
        {formatSize(attachment.size, i18n.language)}
      </span>
    </button>
  );
}

function Tile({ attachment, onOpen }: { attachment: Attachment; onOpen: () => void }) {
  const { t, i18n } = useT();
  const kind = attachmentKind(attachment.filename, attachment.mimeType);
  const dangerous = isDangerous(attachment.filename);
  const Icon = dangerous ? ShieldAlert : ICONS[kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={clsx(
        "flex max-w-[280px] items-center gap-2.5 rounded-xl border py-2 pr-3 pl-2.5 text-left",
        dangerous
          ? "border-danger/40 bg-danger-tint hover:border-danger"
          : "border-line bg-surface hover:border-pink hover:bg-pink-tint/40",
      )}
    >
      <span
        className={clsx(
          "grid size-8 shrink-0 place-items-center rounded-lg",
          dangerous ? "bg-danger/15 text-danger" : "bg-pink-tint text-pink-ink",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold">{attachment.filename}</span>
        <span className={clsx("block text-[11.5px]", dangerous ? "font-semibold text-danger" : "text-muted")}>
          {dangerous ? t("attachment.dangerTag") : formatSize(attachment.size, i18n.language)}
        </span>
      </span>
    </button>
  );
}

export function AttachmentTiles({ attachments, sender }: { attachments: Attachment[]; sender: Address }) {
  const { t } = useT();
  const [viewing, setViewing] = useState<number | null>(null);
  // Inline images are listed too until the reader shows them in the body.
  const visible = attachments;
  if (visible.length === 0) return null;

  const isThumbnail = (attachment: Attachment) =>
    attachmentKind(attachment.filename, attachment.mimeType) === "image" &&
    !isDangerous(attachment.filename) &&
    attachment.size <= THUMBNAIL_LIMIT;

  return (
    <footer className="flex flex-col gap-2 border-t border-hairline pt-4">
      <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-muted">
        <Paperclip className="size-3.5" aria-hidden />
        {t("reader.attachments", { count: visible.length })}
      </p>
      <ul className="flex flex-wrap items-end gap-2">
        {visible.map((attachment, index) => (
          <li key={attachment.id}>
            {isThumbnail(attachment) ? (
              <Thumbnail attachment={attachment} onOpen={() => setViewing(index)} />
            ) : (
              <Tile attachment={attachment} onOpen={() => setViewing(index)} />
            )}
          </li>
        ))}
      </ul>
      <AttachmentViewer attachments={visible} index={viewing} sender={sender} onIndexChange={setViewing} />
    </footer>
  );
}
