import { useState, type ReactNode } from "react";
import type { Account, ServerAccountFeatures } from "@/backend/types";
import { Select } from "@uwusuite/design";
import { useT } from "@/i18n";
import { useAccounts } from "@/lib/queries";
import { MaskedAddresses } from "../masked/MaskedAddresses";
import { useServerAccountFeatures } from "../masked/useMasked";
import { ProfilePictureSettings } from "./ProfilePicture";

type Feature = "masked" | "profile";

/** The mailboxes whose UwUMail server has a feature, in the order of the accounts. */
export function useServerAccounts(feature: Feature): { account: Account; features: ServerAccountFeatures }[] {
  const { data: accounts = [] } = useAccounts();
  const { data: features = [] } = useServerAccountFeatures();
  return accounts.flatMap((account) => {
    const found = features.find((entry) => entry.accountId === account.id);
    return found && found[feature] ? [{ account, features: found }] : [];
  });
}

/** One section for the mailboxes that have a feature, with a choice of mailbox where there are several. */
function ServerAccountSection({
  feature,
  children,
}: {
  feature: Feature;
  children: (account: Account, features: ServerAccountFeatures) => ReactNode;
}) {
  const { t } = useT();
  const entries = useServerAccounts(feature);
  const [chosen, setChosen] = useState<string | null>(null);
  const entry = entries.find((item) => item.account.id === chosen) ?? entries[0];
  if (!entry) return null;
  return (
    <div className="flex flex-col">
      {entries.length > 1 && (
        <Select
          aria-label={t("settings.serverAccount")}
          value={entry.account.id}
          onChange={(event) => setChosen(event.target.value)}
          className="mt-4 max-w-[320px]"
        >
          {entries.map(({ account }) => (
            <option key={account.id} value={account.id}>
              {account.email}
            </option>
          ))}
        </Select>
      )}
      <div key={entry.account.id}>{children(entry.account, entry.features)}</div>
    </div>
  );
}

/** Settings → Masked addresses, per mailbox on a UwUMail server that makes them. */
export function MaskedSettings() {
  return (
    <ServerAccountSection feature="masked">
      {(account, features) => features.masked && <MaskedAddresses accountId={account.id} options={features.masked} />}
    </ServerAccountSection>
  );
}

/** Settings → Profile picture, per mailbox on a UwUMail server that keeps one. */
export function ProfileSettings() {
  return (
    <ServerAccountSection feature="profile">
      {(account, features) =>
        features.profile && <ProfilePictureSettings accountId={account.id} options={features.profile} />
      }
    </ServerAccountSection>
  );
}
