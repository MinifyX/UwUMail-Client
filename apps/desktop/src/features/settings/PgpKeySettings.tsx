import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { backend } from "@/backend/backend";
import { ICONS, Button, IconButton } from "@uwusuite/design";
import { useT } from "@/i18n";
import { toast } from "@/state/toasts";

/** Import and manage the public keys used to verify inline PGP signatures. */
export function PgpKeySettings() {
  const { t } = useT();
  const client = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { data: keys = [] } = useQuery({ queryKey: ["pgpKeys"], queryFn: () => backend().pgpKeys() });

  const importFile = async (text: string, name: string) => {
    setBusy(true);
    try {
      const key = await backend().pgpImportKey(text);
      toast(t("pgpSettings.imported", { name, id: key.userId || key.fingerprint.slice(0, 16) }), "success");
      await client.invalidateQueries({ queryKey: ["pgpKeys"] });
    } catch (error) {
      toast(t("pgpSettings.importFailed", { reason: error instanceof Error ? error.message : String(error) }), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-hairline py-4">
      <p className="mb-2 text-[13px] font-bold">{t("pgpSettings.title")}</p>
      <p className="mb-3 text-[12px] text-muted">{t("pgpSettings.hint")}</p>
      <input
        ref={file}
        type="file"
        accept=".asc,.pub,.pgp,text/plain"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          void f.text().then((text) => importFile(text, f.name));
          e.target.value = "";
        }}
      />
      <Button size="sm" icon={ICONS.add} busy={busy} onClick={() => file.current?.click()}>
        {t("pgpSettings.import")}
      </Button>
      {keys.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {keys.map((key) => (
            <li key={key.fingerprint} className="flex items-center gap-2 rounded-2xl bg-canvas px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-semibold">{key.userId || t("pgpSettings.noUserId")}</p>
                <p className="selectable truncate font-mono text-[11px] text-muted">{key.fingerprint}</p>
              </div>
              <IconButton
                size="sm"
                icon={ICONS.close}
                label={t("pgpSettings.remove")}
                onClick={() =>
                  void backend()
                    .pgpRemoveKey(key.fingerprint)
                    .then(() => client.invalidateQueries({ queryKey: ["pgpKeys"] }))
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
