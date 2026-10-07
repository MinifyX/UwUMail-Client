import { Field, TextInput } from "@uwusuite/design";
import { useEffect, useState } from "react";
import { useT } from "@/i18n";
import { defaultAppPasswordName, MAX_APP_PASSWORD_NAME } from "@/lib/deviceName";

/** The name of the app password a UwUMail sign-in makes, starting as this device's name. */
export function useAppPasswordName() {
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    let live = true;
    void defaultAppPasswordName().then((found) => {
      if (live && !touched) setName(found);
    });
    return () => {
      live = false;
    };
  }, [touched]);
  return {
    name,
    setName: (value: string) => {
      setTouched(true);
      setName(value);
    },
  };
}

export function AppPasswordNameField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useT();
  return (
    <Field label={t("account.appPasswordName")} hint={t("account.appPasswordNameHint")}>
      {(id) => (
        <TextInput
          id={id}
          value={value}
          maxLength={MAX_APP_PASSWORD_NAME}
          autoComplete="off"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}
