import { useQueryClient } from "@tanstack/react-query";
import { Info, Pencil, Plus, Trash } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { backend } from "@/backend/backend";
import type { AccountDomainSignatures, Identity, Signature } from "@/backend/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { useT } from "@/i18n";
import {
  ALL_DOMAINS,
  domainChange,
  editableHtml,
  editorStart,
  identitiesOf,
  previewFor,
  replacedByAllDomains,
  toggleTarget,
  tooLarge,
  type CompanySignature,
  type DomainSignatureChange,
  type DomainSignatureOverview,
  type IdentitySignatureInfo,
  type SignatureText,
} from "@/lib/domainSignatures";
import {
  deviceChange,
  deviceIdentities,
  deviceOverview,
  domainOfAddress,
  isDomainSignature,
  serverIdentity,
} from "@/lib/localSignatures";
import { queryKeys, useAccounts, useDomainSignatures, useIdentities, useSignatures } from "@/lib/queries";
import { foreignHtml, htmlToPlainText, quotableHtml } from "@/lib/safeHtml";
import { toast } from "@/state/toasts";
import { signaturesChangedHere, useAccountSync } from "@/state/accountSync";
import { useUi } from "@/state/ui";
import { Row } from "./Row";
import { SignatureEditor } from "./SignatureEditor";

/**
 * Without a sync account. One array for every render: a selector that returns a new `[]` each time
 * never settles, and React gives up on the whole app (a black window, until a restart).
 */
const NOTHING_UNSYNCED: string[] = [];

/** Bytes a device signature may take (the engine's limit). */
const DEVICE_MAX_BYTES = 1024 * 1024;

const failed = (reason: unknown) => toast(reason instanceof Error ? reason.message : String(reason), "error");

/** What the rich editor gives, as both parts a server keeps: the HTML and the same as text. */
function fromEditor(html: string): SignatureText {
  return html.trim() ? { text: htmlToPlainText(html).trim(), html } : { text: "", html: "" };
}

function asSignature(id: string, signature: SignatureText | null): Signature {
  return { id, email: "", name: "", html: editableHtml(signature), forNew: true, forReplies: true };
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-2xl bg-canvas px-3 py-2 text-[13px] text-muted">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="rounded-full bg-pink-tint px-2 py-0.5 text-[11.5px] font-bold text-pink-ink">{children}</span>
  );
}

/** One domain in the picker: on a server with signatures per domain, or on this device. */
interface DomainEntry {
  key: string;
  domain: string;
  count: number;
  server: AccountDomainSignatures | null;
}

/**
 * Signatures per domain: pick a domain, write one signature for all its addresses; a single
 * address may differ. Domains of a UwUMail server with signatures per domain keep them on the
 * server (the webmail's and the portal's too); every other domain keeps them on this device,
 * next to the signatures of single addresses (lib/localSignatures).
 */
export function Signatures() {
  const { t } = useT();
  const { data: identities = [] } = useIdentities();
  const { data: signatures = [] } = useSignatures();
  const { data: accounts = [] } = useAccounts();
  const servers = useDomainSignatures();
  const [chosen, setChosen] = useState<string | null>(null);

  const local = useMemo(() => deviceIdentities(identities, servers.data), [identities, servers.data]);
  const device = useMemo(() => deviceOverview(local, signatures), [local, signatures]);
  const entries = useMemo(() => {
    const list: DomainEntry[] = [];
    for (const server of servers.data ?? []) {
      for (const info of server.overview.domains) {
        list.push({ key: `${server.accountId}|${info.domain}`, domain: info.domain, count: info.addressCount, server });
      }
    }
    for (const info of device.domains) {
      list.push({ key: `device|${info.domain}`, domain: info.domain, count: info.addressCount, server: null });
    }
    return list;
  }, [servers.data, device]);

  // The servers are asked once; until then their addresses would wrongly look like device ones.
  if (servers.isPending) return null;
  const entry = entries.find((candidate) => candidate.key === chosen) ?? entries[0];
  const label = (candidate: DomainEntry) => {
    const text = t("settings.signatureDomainOption", { domain: candidate.domain, count: candidate.count });
    if (entries.filter((other) => other.domain === candidate.domain).length < 2) return text;
    const where = candidate.server
      ? (accounts.find((account) => account.id === candidate.server!.accountId)?.email ?? "")
      : t("settings.signatureOnDevice");
    return `${text} · ${where}`;
  };

  return (
    <Row label={t("settings.signatures")} description={t("settings.signaturesDomainsDesc")}>
      {entry ? (
        <>
          <Select
            aria-label={t("settings.signatureDomain")}
            value={entry.key}
            onChange={(event) => setChosen(event.target.value)}
          >
            {entries.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {label(candidate)}
              </option>
            ))}
          </Select>
          <p className="text-[12.5px] text-muted">
            {t(entry.server ? "settings.signatureOnServerDesc" : "settings.signatureOnDeviceDesc")}
          </p>
          {entry.server ? (
            <ServerDomain
              key={`${entry.key}:${entry.server.overview.state}`}
              server={entry.server}
              domain={entry.domain}
              identities={identities}
              signatures={signatures}
            />
          ) : (
            <DeviceDomain
              key={`${entry.key}:${device.state}`}
              overview={device}
              domain={entry.domain}
              identities={local}
              signatures={signatures}
            />
          )}
        </>
      ) : (
        <p className="text-[13px] text-muted">{t("settings.signaturesNoAddresses")}</p>
      )}
    </Row>
  );
}

/** The editor of one domain's signature with "applies to"; `children` are its exceptions. */
function DomainEditor({
  overview,
  domain,
  maxBytes,
  onSave,
  children,
}: {
  overview: DomainSignatureOverview;
  domain: string;
  maxBytes?: number;
  onSave: (change: DomainSignatureChange) => Promise<void>;
  children?: ReactNode;
}) {
  const { t } = useT();
  const start = useMemo(() => editorStart(overview, domain), [overview, domain]);
  const [targets, setTargets] = useState<string[]>(start.targets);
  const info = overview.domains.find((candidate) => candidate.domain === domain);
  const all = targets.includes(ALL_DOMAINS);
  const replaced = all ? replacedByAllDomains(overview, domain) : [];
  const sample = identitiesOf(overview, domain)[0];
  const footer: CompanySignature | null = info?.company?.mode === "footer" ? info.company : null;

  return (
    <div className="flex flex-col gap-3">
      {start.origin === "template" && <Note>{t("settings.signatureFromTemplate")}</Note>}
      {start.origin === "allDomains" && <Note>{t("settings.signatureFromAllDomains")}</Note>}
      <SignatureEditor
        signature={asSignature(`domain:${domain}`, start.signature)}
        simple
        placeholders
        onSave={async (signature) => {
          const value = fromEditor(foreignHtml(signature.html));
          if (tooLarge(value, maxBytes)) {
            toast(t("settings.signatureTooBig"), "error");
            return;
          }
          await onSave(domainChange(overview, targets, value));
        }}
      />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-[13px] font-semibold text-muted">{t("settings.signatureAppliesTo")}</legend>
        <label className="flex items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) => setTargets(toggleTarget(targets, ALL_DOMAINS, event.target.checked, domain))}
          />
          {t("settings.signatureAllDomains")}
        </label>
        {!all &&
          overview.domains.map((candidate) => (
            <label key={candidate.domain} className="flex items-center gap-2 text-[13.5px]">
              <input
                type="checkbox"
                checked={targets.includes(candidate.domain)}
                onChange={(event) => setTargets(toggleTarget(targets, candidate.domain, event.target.checked, domain))}
              />
              {t("settings.signatureDomainOption", { domain: candidate.domain, count: candidate.addressCount })}
            </label>
          ))}
        {replaced.length > 0 && (
          <p className="text-[12px] text-muted">{t("settings.signatureReplaces", { domains: replaced.join(", ") })}</p>
        )}
      </fieldset>
      {(start.origin === "domain" || start.origin === "allDomains") && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => void onSave(domainChange(overview, start.targets, null))}
        >
          {t("settings.signatureRemove")}
        </Button>
      )}
      {footer && (
        <Note>
          {t("settings.signatureCompanyFooter")}
          <span className="mt-1 block whitespace-pre-wrap">
            {sample ? previewFor({ text: footer.text, html: "" }, sample).text : footer.text}
          </span>
        </Note>
      )}
      {children}
    </div>
  );
}

/** A domain on a UwUMail server with signatures per domain. */
function ServerDomain({
  server,
  domain,
  identities,
  signatures,
}: {
  server: AccountDomainSignatures;
  domain: string;
  identities: Identity[];
  signatures: Signature[];
}) {
  const { t } = useT();
  const client = useQueryClient();
  const save = async (change: DomainSignatureChange) => {
    try {
      const saved = await backend().saveDomainSignatures(server.accountId, change);
      client.setQueryData<AccountDomainSignatures[]>(queryKeys.domainSignatures, (old) =>
        (old ?? []).map((entry) => (entry.accountId === saved.accountId ? saved : entry)),
      );
      toast(t("settings.signatureSaved"), "success");
    } catch (reason) {
      failed(reason);
    }
  };
  const addresses = identitiesOf(server.overview, domain);
  const exceptions = addresses.filter((identity) => identity.signature !== null).length;
  const start = editorStart(server.overview, domain);
  // Own device signatures of these addresses still go first on this device; they stay editable.
  const withDeviceSignatures = identities.filter(
    (identity) =>
      identity.accountId === server.accountId &&
      domainOfAddress(identity.email) === domain &&
      serverIdentity([server], identity) !== null &&
      signatures.some((signature) => signature.email.toLowerCase() === identity.email.toLowerCase()),
  );

  return (
    <DomainEditor overview={server.overview} domain={domain} onSave={save}>
      {addresses.length > 0 && (
        <details className="rounded-2xl border border-hairline px-3 py-1.5" open={exceptions > 0}>
          <summary className="cursor-pointer py-1 text-[13.5px] font-semibold">
            {t("settings.signatureExceptions", { count: exceptions })}
          </summary>
          <ul className="flex flex-col divide-y divide-hairline">
            {addresses.map((identity) => (
              <AddressOverride
                key={`${identity.id}:${identity.signature?.html ?? ""}:${identity.signature?.text ?? ""}`}
                identity={identity}
                fallback={start.signature}
                onSave={save}
              />
            ))}
          </ul>
        </details>
      )}
      {withDeviceSignatures.length > 0 && (
        <>
          <Note>{t("settings.signatureDeviceFirst")}</Note>
          <AddressSignatures identities={withDeviceSignatures} allowAdd={false} />
        </>
      )}
    </DomainEditor>
  );
}

/** One address on the server that may have a signature of its own instead of its domain's. */
function AddressOverride({
  identity,
  fallback,
  onSave,
}: {
  identity: IdentitySignatureInfo;
  fallback: SignatureText;
  onSave: (change: DomainSignatureChange) => Promise<void>;
}) {
  const { t } = useT();
  const own = identity.signature !== null;
  const [editing, setEditing] = useState(own);

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
          {identity.name ? `${identity.name} <${identity.email}>` : identity.email}
        </span>
        <span className="text-[12px] text-muted">
          {own ? t("settings.signatureOwn") : t("settings.signatureFollowsDomain")}
        </span>
      </div>
      {editing ? (
        <>
          <SignatureEditor
            signature={asSignature(identity.id, identity.signature ?? fallback)}
            simple
            placeholders
            onSave={async (signature) => {
              const value = fromEditor(foreignHtml(signature.html));
              if (tooLarge(value)) {
                toast(t("settings.signatureTooBig"), "error");
                return;
              }
              await onSave({ identities: { [identity.id]: value } });
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => {
              setEditing(false);
              if (own) void onSave({ identities: { [identity.id]: null } });
            }}
          >
            {t("settings.signatureBackToDomain")}
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setEditing(true)}>
          {t("settings.signatureOverride")}
        </Button>
      )}
    </li>
  );
}

/** A domain whose signatures stay on this device. */
function DeviceDomain({
  overview,
  domain,
  identities,
  signatures,
}: {
  overview: DomainSignatureOverview;
  domain: string;
  identities: Identity[];
  signatures: Signature[];
}) {
  const { t } = useT();
  const client = useQueryClient();
  const save = async (change: DomainSignatureChange) => {
    const { save: put, remove } = deviceChange(change, signatures);
    try {
      for (const id of remove) await backend().deleteSignature(id);
      for (const signature of put) await backend().saveSignature(signature);
      toast(t("settings.signatureSaved"), "success");
    } catch (reason) {
      failed(reason);
    } finally {
      signaturesChangedHere();
      await client.invalidateQueries({ queryKey: queryKeys.signatures });
    }
  };
  const addresses = identities.filter((identity) => domainOfAddress(identity.email) === domain);
  const exceptions = addresses.filter((identity) =>
    signatures.some((signature) => signature.email.toLowerCase() === identity.email.toLowerCase()),
  ).length;

  return (
    <DomainEditor overview={overview} domain={domain} maxBytes={DEVICE_MAX_BYTES} onSave={save}>
      {addresses.length > 0 && (
        <details className="rounded-2xl border border-hairline px-3 py-1.5" open={exceptions > 0}>
          <summary className="cursor-pointer py-1 text-[13.5px] font-semibold">
            {t("settings.signatureExceptions", { count: exceptions })}
          </summary>
          <div className="flex flex-col gap-2 py-2">
            <AddressSignatures identities={addresses} allowAdd />
          </div>
        </details>
      )}
    </DomainEditor>
  );
}

/**
 * The device signatures of single addresses, as the app always had them: several per address,
 * each one for new mail, replies or both. They go first, on this device.
 */
function AddressSignatures({ identities, allowAdd }: { identities: Identity[]; allowAdd: boolean }) {
  const { t } = useT();
  const client = useQueryClient();
  const { data: signatures = [] } = useSignatures();
  const [chosen, setChosen] = useState<string | null>(null);
  const email =
    chosen && identities.some((identity) => identity.email === chosen) ? chosen : (identities[0]?.email ?? "");
  const [editing, setEditing] = useState<Signature | null>(null);
  const own = signatures.filter(
    (signature) => !isDomainSignature(signature) && signature.email.toLowerCase() === email.toLowerCase(),
  );
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  // The settings window shouldn't vanish (backdrop click, Escape) while a signature is mid-edit.
  useEffect(() => {
    setSettingsFormDirty(editing !== null);
    return () => setSettingsFormDirty(false);
  }, [editing, setSettingsFormDirty]);

  const unsynced = useAccountSync((s) => (s.accountId ? s.unsynced : NOTHING_UNSYNCED));
  const refresh = () => {
    signaturesChangedHere();
    return client.invalidateQueries({ queryKey: queryKeys.signatures });
  };

  return (
    <div className="flex flex-col gap-2.5">
      {identities.length > 1 && (
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
      )}
      {identities.length === 1 && <p className="text-[13px] font-semibold">{email}</p>}

      {editing ? (
        <SignatureEditor
          key={editing.id || "new"}
          signature={editing}
          placeholders
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
                    {unsynced.includes(signature.id) && <Badge>{t("settings.signatureLocalOnly")}</Badge>}
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
                  {unsynced.includes(signature.id) && (
                    <p className="mt-2 text-[12.5px] text-muted">{t("settings.signatureLocalOnlyDesc")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {allowAdd && (
            <Button
              size="sm"
              variant="ghost"
              icon={Plus}
              className="self-start"
              disabled={!email}
              onClick={() =>
                setEditing({
                  id: "",
                  email,
                  name: "",
                  html: "",
                  forNew: own.length === 0,
                  forReplies: own.length === 0,
                })
              }
            >
              {t("settings.newSignature")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
