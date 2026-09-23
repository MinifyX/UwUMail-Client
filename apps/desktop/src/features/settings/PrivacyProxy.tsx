import { useState } from "react";
import { backend } from "@/backend/backend";
import { Button } from "@/components/ui/Button";
import { Field, TextInput } from "@/components/ui/Field";
import { useT } from "@/i18n";
import { useSettings } from "@/state/settings";
import { toast } from "@/state/toasts";

/**
 * The proxy a mail's remote pictures, sender pictures and one-click unsubscribes take, e.g. a VPN's
 * SOCKS5 proxy. Mail itself never does. Checked by the app before it is kept.
 */
export function PrivacyProxy() {
  const { t } = useT();
  const saved = useSettings((s) => s.privacyProxy);
  const update = useSettings((s) => s.update);
  const [text, setText] = useState(saved);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();

  const save = async () => {
    setBusy(true);
    try {
      await backend().setPrivacyProxy(trimmed);
      update({ privacyProxy: trimmed });
      setInvalid(false);
      toast(trimmed ? t("settings.proxySaved") : t("settings.proxyRemoved"), "success");
    } catch {
      setInvalid(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 border-b border-hairline py-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field
        label={t("settings.proxy")}
        hint={t("settings.proxyDesc")}
        error={invalid ? t("settings.proxyInvalid") : undefined}
      >
        {(id) => (
          <TextInput
            id={id}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="socks5://127.0.0.1:1080"
            value={text}
            aria-invalid={invalid}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>
      {trimmed !== saved && (
        <Button type="submit" size="sm" variant="primary" busy={busy} className="self-start">
          {t("common.save")}
        </Button>
      )}
    </form>
  );
}
