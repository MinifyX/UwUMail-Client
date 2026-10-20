import { Button, IconButton, ICONS, Menu, TextInput } from "@uwusuite/design";
import { useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { useT } from "@/i18n";
import { quotableHtml } from "@/lib/safeHtml";
import { MAX_VALUE_BYTES, valueBytes } from "@/lib/settingsSync";
import { withoutSignatureMarker } from "@/lib/signatures";
import {
  cleanTemplateName,
  cleanTemplateSubject,
  newTemplateId,
  sortedTemplates,
  TEMPLATE_NAME_MAX,
} from "@/lib/templates";
import { useSettings, type MailTemplate } from "@/state/settings";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { splitDraft } from "../assist/draftText";

/** The composer's template button: put one in, keep the draft as one, or manage them. */
export function TemplatesMenu({
  open,
  onOpenChange,
  onPick,
  onSaveDraft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (template: MailTemplate) => void;
  onSaveDraft: () => void;
}) {
  const { t } = useT();
  const templates = useSettings((s) => s.templates);
  const list = sortedTemplates(templates);
  return (
    <Menu
      side="above"
      open={open}
      onOpenChange={onOpenChange}
      items={[
        ...(list.length > 0
          ? [
              { heading: t("templates.title") },
              ...list.map(([id, template]) => ({
                label: template.name,
                icon: ICONS.document,
                onSelect: () => onPick(templates[id]!),
              })),
              "separator" as const,
            ]
          : [{ heading: t("templates.none") }]),
        { label: t("templates.saveDraft"), icon: ICONS.save, onSelect: onSaveDraft },
        {
          label: t("templates.manage"),
          icon: ICONS.edit,
          onSelect: () => useUi.getState().openSettings("compose"),
        },
      ]}
      trigger={(menu) => (
        <IconButton
          icon={ICONS.insert}
          size="sm"
          label={t("templates.insert")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={menu.toggle}
          aria-haspopup={menu["aria-haspopup"]}
          aria-expanded={menu["aria-expanded"]}
          aria-controls={menu["aria-controls"]}
        />
      )}
    />
  );
}

/** Keeps what the person wrote (no signature, no quote) and the subject as a new template. */
export function SaveTemplateDialog({
  open,
  subject,
  html,
  onClose,
}: {
  open: boolean;
  subject: string;
  /** The draft's body as it is when saving. */
  html: () => string;
  onClose: () => void;
}) {
  const { t } = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t("templates.saveDraft")} width="sm">
      {open && <SaveTemplateForm subject={subject} html={html} onClose={onClose} />}
    </Dialog>
  );
}

function SaveTemplateForm({ subject, html, onClose }: { subject: string; html: () => string; onClose: () => void }) {
  const { t } = useT();
  const [name, setName] = useState(() => cleanTemplateName(subject));
  const save = () => {
    const template: MailTemplate = {
      name: cleanTemplateName(name) || t("templates.untitled"),
      subject: cleanTemplateSubject(subject),
      html: withoutSignatureMarker(quotableHtml(splitDraft(html()).own)),
    };
    if (valueBytes(template) > MAX_VALUE_BYTES) {
      toast(t("templates.tooBig"), "error");
      return;
    }
    useSettings.getState().saveTemplate(newTemplateId(), template);
    toast(t("templates.saved", { name: template.name }), "success");
    onClose();
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <p className="text-[13px] text-muted">{t("templates.saveDraftHint")}</p>
      <TextInput
        autoFocus
        aria-label={t("templates.name")}
        placeholder={t("templates.namePlaceholder")}
        value={name}
        maxLength={TEMPLATE_NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        className="h-10"
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" type="submit">
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}
