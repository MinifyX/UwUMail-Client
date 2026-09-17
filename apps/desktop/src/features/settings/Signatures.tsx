import { useQueryClient } from "@tanstack/react-query";
import { Bold, ImagePlus, Italic, Link, Pencil, Plus, Trash } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { backend } from "@/backend/backend";
import type { Signature } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Select, TextInput, Toggle } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { pictureAsDataUrl } from "@/lib/images";
import { queryKeys, useIdentities, useSignatures } from "@/lib/queries";
import { isSafeLinkTarget, quotableHtml } from "@/lib/safeHtml";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { Row } from "./Row";

export function Signatures() {
  const { t } = useT();
  const client = useQueryClient();
  const { data: identities = [] } = useIdentities();
  const { data: signatures = [] } = useSignatures();
  const [chosen, setChosen] = useState<string | null>(null);
  const email = chosen ?? identities[0]?.email ?? "";
  const [editing, setEditing] = useState<Signature | null>(null);
  const own = signatures.filter((s) => s.email.toLowerCase() === email.toLowerCase());
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  // The settings window shouldn't vanish (backdrop click, Escape) while a signature is mid-edit.
  useEffect(() => {
    setSettingsFormDirty(editing !== null);
    return () => setSettingsFormDirty(false);
  }, [editing, setSettingsFormDirty]);

  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.signatures });
  const failed = (reason: unknown) => toast(reason instanceof Error ? reason.message : String(reason), "error");

  return (
    <Row label={t("settings.signatures")} description={t("settings.signaturesDesc")}>
      <Select
        aria-label={t("settings.signatureFor")}
        value={email}
        onChange={(event) => {
          setChosen(event.target.value);
          setEditing(null);
        }}
      >
        {identities.map((identity) => (
          <option key={identity.id} value={identity.email}>
            {identity.name ? `${identity.name} <${identity.email}>` : identity.email}
          </option>
        ))}
      </Select>

      {editing ? (
        <SignatureEditor
          key={editing.id || "new"}
          signature={editing}
          onCancel={() => setEditing(null)}
          onSave={async (signature) => {
            try {
              await backend().saveSignature(signature);
              toast(t("settings.signatureSaved"), "success");
              setEditing(null);
              await refresh();
            } catch (reason) {
              failed(reason);
            }
          }}
        />
      ) : (
        <>
          {own.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
              {t("settings.signaturesEmpty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {own.map((signature) => (
                <li key={signature.id} className="rounded-2xl border border-hairline p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{signature.name}</span>
                    {signature.forNew && <Badge>{t("settings.signatureDefaultNew")}</Badge>}
                    {signature.forReplies && <Badge>{t("settings.signatureDefaultReplies")}</Badge>}
                    <IconButton
                      icon={Pencil}
                      size="sm"
                      label={t("settings.editSignature", { name: signature.name })}
                      onClick={() => setEditing(signature)}
                    />
                    <IconButton
                      icon={Trash}
                      size="sm"
                      label={t("settings.deleteSignature", { name: signature.name })}
                      onClick={() => void backend().deleteSignature(signature.id).then(refresh, failed)}
                    />
                  </div>
                  <div
                    className="signature-preview mt-2 text-[13px] text-muted [&_img]:max-h-16 [&_img]:w-auto [&_p]:m-0"
                    // Saved through the same sanitizer as the composer; pictures are data URLs only.
                    dangerouslySetInnerHTML={{ __html: quotableHtml(signature.html) }}
                  />
                </li>
              ))}
            </ul>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={Plus}
            className="self-start"
            disabled={!email}
            onClick={() =>
              setEditing({ id: "", email, name: "", html: "", forNew: own.length === 0, forReplies: own.length === 0 })
            }
          >
            {t("settings.newSignature")}
          </Button>
        </>
      )}
    </Row>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-pink-tint px-2 py-0.5 text-[11.5px] font-bold text-pink-ink">{children}</span>
  );
}

function SignatureEditor({
  signature,
  onSave,
  onCancel,
}: {
  signature: Signature;
  onSave: (signature: Signature) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState(signature.name);
  const [forNew, setForNew] = useState(signature.forNew);
  const [forReplies, setForReplies] = useState(signature.forReplies);
  const [saving, setSaving] = useState(false);
  const editor = useRef<HTMLDivElement | null>(null);
  const picture = useRef<HTMLInputElement>(null);

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
      <TextInput
        aria-label={t("settings.signatureName")}
        placeholder={t("settings.signatureNamePlaceholder")}
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="h-10"
      />
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="flex items-center gap-1 border-b border-hairline bg-canvas px-1.5 py-1">
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
          <input
            ref={picture}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                const url = await pictureAsDataUrl(file);
                editor.current?.focus();
                document.execCommand("insertImage", false, url);
              } catch {
                toast(t("settings.signatureImageFailed"), "error");
              }
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
          className="min-h-28 px-3 py-2 text-[14px] leading-relaxed outline-none empty:before:pointer-events-none empty:before:text-faint empty:before:content-[attr(data-placeholder)] [&_a]:text-pink-ink [&_a]:underline [&_img]:inline-block [&_img]:max-w-full [&_p]:min-h-[1.4em]"
        />
      </div>
      <Toggle checked={forNew} onChange={setForNew} label={t("settings.signatureForNew")} />
      <Toggle checked={forReplies} onChange={setForReplies} label={t("settings.signatureForReplies")} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          busy={saving}
          onClick={async () => {
            setSaving(true);
            await onSave({
              ...signature,
              name: name.trim() || t("settings.signatureUntitled"),
              html: quotableHtml(editor.current?.innerHTML ?? ""),
              forNew,
              forReplies,
            });
            setSaving(false);
          }}
        >
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
