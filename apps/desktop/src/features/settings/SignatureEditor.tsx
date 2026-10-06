import { Bold, ImagePlus, Italic, Link } from "lucide-react";
import { useRef, useState } from "react";
import type { Signature } from "@/backend/types";
import { Button, IconButton, TextInput, Toggle } from "@uwusuite/design";
import { useT } from "@/i18n";
import { PLACEHOLDERS } from "@/lib/domainSignatures";
import { pictureAsDataUrl } from "@/lib/images";
import { foreignHtml, isSafeLinkTarget, quotableHtml } from "@/lib/safeHtml";
import { toast } from "@/state/toasts";
import { insertDroppedHtml } from "@/features/compose/droppedHtml";

/** What a whole signature may take (the server's and the settings sync's largest value). */
const SIGNATURE_MAX_BYTES = 262_144;
/** Room kept free next to a new picture, for the other fields and the markup around it. */
const PICTURE_HEADROOM = 2048;
const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The rich editor of one signature: bold, italic, links and pictures, cleaned like the composer. */
export function SignatureEditor({
  signature,
  simple = false,
  placeholders = false,
  saveLabel,
  onSave,
  onCancel,
}: {
  signature: Signature;
  /** One signature for a domain or an address: no name, used for new mail and replies alike. */
  simple?: boolean;
  /** Offers the placeholders filled per address ({name}, {adresse}, {domain}). */
  placeholders?: boolean;
  saveLabel?: string;
  onSave: (signature: Signature) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(signature.name);
  const [forNew, setForNew] = useState(signature.forNew);
  const [forReplies, setForReplies] = useState(signature.forReplies);
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLDivElement | null>(null);
  /** A drag that started in the editor itself: moving text, not markup from elsewhere. */
  const draggingInside = useRef(false);
  const picture = useRef<HTMLInputElement>(null);

  /** Puts a picture in as an embedded data URL, shrunk until the whole signature still fits. */
  const insertPicture = async (file: File) => {
    const room = SIGNATURE_MAX_BYTES - bytes(editor.current?.innerHTML ?? "") - PICTURE_HEADROOM;
    try {
      if (room <= 0) throw new Error("too big");
      const url = await pictureAsDataUrl(file, 480, room);
      editor.current?.focus();
      document.execCommand("insertImage", false, url);
    } catch (reason) {
      const tooBig = reason instanceof Error && reason.message === "too big";
      toast(t(tooBig ? "settings.signatureTooBig" : "settings.signatureImageFailed"), "error");
    }
  };

  const format = (command: "bold" | "italic" | "createLink") => {
    editor.current?.focus();
    if (command === "createLink") {
      const url = window.prompt(t("compose.linkPrompt"), "https://");
      if (url && isSafeLinkTarget(url)) document.execCommand("createLink", false, url.trim());
      return;
    }
    document.execCommand(command);
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-line p-3">
      {!simple && (
        <TextInput
          aria-label={t("settings.signatureName")}
          placeholder={t("settings.signatureNamePlaceholder")}
          value={name}
          maxLength={100}
          onChange={(event) => setName(event.target.value)}
          className="h-10"
        />
      )}
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex flex-wrap items-center gap-1 border-b border-hairline bg-canvas px-1.5 py-1">
          <IconButton
            icon={Bold}
            size="sm"
            label={t("compose.bold")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format("bold")}
          />
          <IconButton
            icon={Italic}
            size="sm"
            label={t("compose.italic")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format("italic")}
          />
          <IconButton
            icon={Link}
            size="sm"
            label={t("compose.link")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => format("createLink")}
          />
          <IconButton
            icon={ImagePlus}
            size="sm"
            label={t("settings.signatureImage")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => picture.current?.click()}
          />
          {placeholders &&
            PLACEHOLDERS.map((placeholder) => (
              <button
                key={placeholder}
                type="button"
                className="rounded-full border border-line px-2 py-0.5 font-mono text-[12px] text-muted hover:border-pink"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editor.current?.focus();
                  document.execCommand("insertText", false, placeholder);
                }}
              >
                {placeholder}
              </button>
            ))}
          <input
            ref={picture}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void insertPicture(file);
            }}
          />
        </div>
        <div
          ref={(node) => {
            editor.current = node;
            if (node && node.innerHTML === "" && signature.html) node.innerHTML = quotableHtml(signature.html);
          }}
          contentEditable
          role="textbox"
          aria-multiline
          aria-label={t("settings.signatures")}
          data-placeholder={t("settings.signaturePlaceholder")}
          onPaste={(event) => {
            // A pasted picture file becomes a data URL like an inserted one; pasted markup (e.g.
            // copied out of a mail) is cleaned before it lands in the app page, so nothing remote
            // in it loads while editing. Plain text goes in as text, so WebKit can't paste a rich
            // flavour of the clipboard behind the page's back.
            const file = [...event.clipboardData.files].find((item) => item.type.startsWith("image/"));
            const html = event.clipboardData.getData("text/html");
            const text = event.clipboardData.getData("text/plain");
            if (file && !html) {
              event.preventDefault();
              void insertPicture(file);
              return;
            }
            if (!html && !text) return;
            event.preventDefault();
            const cleaned = html
              ? foreignHtml(html)
              : text
                  .replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)
                  .replace(/\r?\n/g, "<br>");
            document.execCommand("insertHTML", false, cleaned);
          }}
          onDragStart={() => {
            draggingInside.current = true;
          }}
          onDragEnd={() => {
            draggingInside.current = false;
          }}
          onDrop={(event) => {
            if (!draggingInside.current) insertDroppedHtml(event, foreignHtml);
          }}
          className="min-h-28 px-3 py-2 text-[14px] leading-relaxed outline-none empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)] [&_a]:text-pink-ink [&_a]:underline [&_img]:inline-block [&_img]:max-w-full [&_p]:min-h-[1.4em]"
        />
      </div>
      {!simple && (
        <>
          <Toggle checked={forNew} onChange={setForNew} label={t("settings.signatureForNew")} />
          <Toggle checked={forReplies} onChange={setForReplies} label={t("settings.signatureForReplies")} />
        </>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
        <Button
          variant="primary"
          busy={saving}
          onClick={async () => {
            setSaving(true);
            await onSave({
              ...signature,
              name: name.trim() || t("settings.signatureUntitled"),
              html: foreignHtml(editor.current?.innerHTML ?? ""),
              forNew,
              forReplies,
            });
            setSaving(false);
          }}
        >
          {saveLabel ?? t("common.save")}
        </Button>
      </div>
    </div>
  );
}
