import { useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Copy, ExternalLink, Info, Pencil, Plus, RotateCcw, Search, Trash, X } from "lucide-react";
import { createContext, useContext, useEffect, useState, type FormEvent } from "react";
import { backend } from "@/backend/backend";
import type { MaskedAddress, MaskedAddressPatch, MaskedOptions } from "@/backend/types";
import { Button, Field, IconButton, Segmented, Select, Switch, TextInput } from "@uwusuite/design";
import { translate, useT } from "@/i18n";
import {
  countByFilter,
  MASKED_FILTERS,
  MASKED_LIMITS,
  maskedInput,
  maskedProblems,
  openableUrl,
  siteLabel,
  visibleMasked,
  type MaskedField,
  type MaskedFilter,
  type MaskedForm,
} from "@/lib/maskedAddresses";
import { queryKeys } from "@/lib/queries";
import { openLinkNow } from "@/state/links";
import { toast } from "@/state/toasts";
import { useUi } from "@/state/ui";
import { maskedErrorText, useMaskedAddresses } from "./useMasked";

/** The mailbox whose masked addresses are shown. */
const MaskedAccount = createContext("");

/**
 * Settings → Masked addresses: random addresses for single websites that deliver here, so a site
 * never learns the real one and one that starts to spam is switched off. The server keeps them
 * (Fastmail's JMAP MaskedEmail), the same ones the portal and password managers make. Only for
 * mailboxes on a UwUMail server; `options` are what that server allows.
 */
export function MaskedAddresses({ accountId, options }: { accountId: string; options: MaskedOptions }) {
  const { t } = useT();
  const [createDirty, setCreateDirty] = useState(false);
  const [editDirty, setEditDirty] = useState(false);
  const setSettingsFormDirty = useUi((s) => s.setSettingsFormDirty);
  // The settings window shouldn't vanish while an address is half written.
  useEffect(() => {
    setSettingsFormDirty(createDirty || editDirty);
    return () => setSettingsFormDirty(false);
  }, [createDirty, editDirty, setSettingsFormDirty]);

  // The server names the domains, and there are none: nobody enabled them for this account.
  const closed = options.domains !== null && options.domains.length === 0;
  return (
    <MaskedAccount.Provider value={accountId}>
      <div className="flex flex-col gap-4 py-4">
        <div>
          <p className="text-sm font-semibold">{t("masked.title")}</p>
          <p className="text-[13px] text-muted">{t("masked.description")}</p>
        </div>
        {closed ? (
          <div className="flex gap-2 rounded-2xl bg-canvas px-4 py-3 text-[13px]">
            <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
            <div>
              <p className="font-semibold">{t("masked.closedTitle")}</p>
              <p className="text-muted">{t("masked.closedBody")}</p>
            </div>
          </div>
        ) : (
          <NewMasked options={options} onDirty={setCreateDirty} />
        )}
        <MaskedList onDirty={setEditDirty} />
      </div>
    </MaskedAccount.Provider>
  );
}

function copyAddress(email: string) {
  const copying = navigator.clipboard?.writeText(email) ?? Promise.reject(new Error("No clipboard"));
  void copying.then(
    () => toast(translate("masked.copied"), "success"),
    () => toast(translate("masked.copyFailed"), "error"),
  );
}

function CopyButton({ email }: { email: string }) {
  const { t } = useT();
  return <IconButton icon={Copy} size="sm" label={t("masked.copy", { email })} onClick={() => copyAddress(email)} />;
}

/** The button for a new one, its form, and the address it made. */
function NewMasked({ options, onDirty }: { options: MaskedOptions; onDirty: (dirty: boolean) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<MaskedAddress | null>(null);

  if (made) {
    return (
      <div role="status" className="flex flex-col gap-2 rounded-2xl bg-pink-tint/50 px-4 py-3">
        <p className="text-[13px] font-semibold">{t("masked.created")}</p>
        <div className="flex min-w-0 items-center gap-2">
          <span className="selectable min-w-0 text-[15px] font-bold break-all">{made.email}</span>
          <CopyButton email={made.email} />
        </div>
        <Button size="sm" className="self-start" onClick={() => setMade(null)}>
          {t("masked.done")}
        </Button>
      </div>
    );
  }
  if (!open) {
    return (
      <Button icon={Plus} className="self-start" onClick={() => setOpen(true)}>
        {t("masked.new")}
      </Button>
    );
  }
  return (
    <CreateForm
      options={options}
      onDirty={onDirty}
      onCancel={() => setOpen(false)}
      onMade={(address) => {
        setOpen(false);
        setMade(address);
      }}
    />
  );
}

const EMPTY_FORM: MaskedForm = { description: "", forDomain: "", url: "", emailPrefix: "" };

/** The problem with a field, in words; undefined when there is none. */
function useProblemText() {
  const { t } = useT();
  return (problems: ReturnType<typeof maskedProblems>, field: MaskedField): string | undefined => {
    const problem = problems[field];
    if (!problem) return undefined;
    const max = field === "emailPrefix" ? MASKED_LIMITS.prefix : MASKED_LIMITS[field];
    return t(`masked.problem.${problem}`, { max });
  };
}

/** Description, site and link, shared by the new address and the editor. */
function DetailFields({
  form,
  problems,
  onChange,
}: {
  form: MaskedForm;
  problems: ReturnType<typeof maskedProblems>;
  onChange: (patch: Partial<MaskedForm>) => void;
}) {
  const { t } = useT();
  const problemText = useProblemText();
  return (
    <>
      <Field label={t("masked.field.description")} error={problemText(problems, "description")}>
        {(id) => (
          <TextInput
            id={id}
            value={form.description}
            placeholder={t("masked.placeholder.description")}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        )}
      </Field>
      <Field label={t("masked.field.site")} error={problemText(problems, "forDomain")}>
        {(id) => (
          <TextInput
            id={id}
            value={form.forDomain}
            placeholder="shop.example.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onChange({ forDomain: event.target.value })}
          />
        )}
      </Field>
      <Field label={t("masked.field.url")} hint={t("masked.hint.url")} error={problemText(problems, "url")}>
        {(id) => (
          <TextInput
            id={id}
            type="url"
            value={form.url}
            placeholder="https://shop.example.com/account"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onChange({ url: event.target.value })}
          />
        )}
      </Field>
    </>
  );
}

function CreateForm({
  options,
  onDirty,
  onCancel,
  onMade,
}: {
  options: MaskedOptions;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onMade: (address: MaskedAddress) => void;
}) {
  const { t } = useT();
  const client = useQueryClient();
  const accountId = useContext(MaskedAccount);
  const problemText = useProblemText();
  const domains = options.domains ?? [];
  const [form, setForm] = useState<MaskedForm>(EMPTY_FORM);
  // The server's default, or "automatic" (the server decides) where it names none.
  const [domain, setDomain] = useState(options.defaultDomain ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = maskedProblems(form);
  const dirty = Object.values(form).some((value) => value.trim() !== "");

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      // With one domain (or none named) the server's default is the only choice anyway.
      const made = await backend().createMaskedAddress(
        accountId,
        maskedInput(form, domains.length > 1 && domain ? domain : undefined),
      );
      client.setQueryData<MaskedAddress[]>(queryKeys.maskedAddresses(accountId), (list) =>
        list ? [made, ...list.filter((item) => item.id !== made.id)] : list,
      );
      void client.invalidateQueries({ queryKey: queryKeys.maskedAddresses(accountId) });
      onMade(made);
    } catch (reason) {
      setError(maskedErrorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label={t("masked.new")}
      className="flex flex-col gap-3 rounded-2xl border border-hairline p-4"
    >
      <p className="text-sm font-semibold">{t("masked.new")}</p>
      <DetailFields form={form} problems={problems} onChange={(patch) => setForm({ ...form, ...patch })} />
      <Field
        label={t("masked.field.prefix")}
        hint={t("masked.hint.prefix")}
        error={problemText(problems, "emailPrefix")}
      >
        {(id) => (
          <TextInput
            id={id}
            value={form.emailPrefix}
            placeholder="shop"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={MASKED_LIMITS.prefix + 8}
            onChange={(event) => setForm({ ...form, emailPrefix: event.target.value })}
          />
        )}
      </Field>
      {domains.length > 1 && (
        <Field label={t("masked.field.domain")}>
          {(id) => (
            <Select id={id} value={domain} onChange={(event) => setDomain(event.target.value)}>
              {!options.defaultDomain && <option value="">{t("masked.domainAutomatic")}</option>}
              {domains.map((name) => (
                <option key={name} value={name}>
                  @{name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {domains.length === 1 && (
        <p className="text-[12.5px] text-muted">{t("masked.onDomain", { domain: domains[0] })}</p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={busy} disabled={Object.keys(problems).length > 0}>
          {t("masked.create")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

function MaskedList({ onDirty }: { onDirty: (dirty: boolean) => void }) {
  const { t } = useT();
  const client = useQueryClient();
  const accountId = useContext(MaskedAccount);
  const query = useMaskedAddresses(accountId);
  const [filter, setFilter] = useState<MaskedFilter>("active");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (query.isPending) return <p className="text-[13px] text-muted">{t("masked.loading")}</p>;
  if (query.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[13px] text-danger">{t("masked.loadFailed", { reason: maskedErrorText(query.error) })}</p>
        <Button size="sm" onClick={() => void query.refetch()}>
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const all = query.data;
  if (all.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
        {t("masked.empty")}
      </p>
    );
  }
  const counts = countByFilter(all);
  const visible = visibleMasked(all, filter, search);

  /** Changes one and keeps the list in step; resolves whether it worked. */
  const change = async (item: MaskedAddress, patch: MaskedAddressPatch): Promise<boolean> => {
    setBusyId(item.id);
    try {
      await backend().updateMaskedAddress(accountId, item.id, patch);
      client.setQueryData<MaskedAddress[]>(queryKeys.maskedAddresses(accountId), (list) =>
        list?.map((entry) => (entry.id === item.id ? { ...entry, ...patch } : entry)),
      );
      return true;
    } catch (reason) {
      toast(maskedErrorText(reason), "error");
      return false;
    } finally {
      setBusyId(null);
      void client.invalidateQueries({ queryKey: queryKeys.maskedAddresses(accountId) });
    }
  };

  const remove = async (item: MaskedAddress) => {
    if (!(await change(item, { state: "deleted" }))) return;
    // Back as it was; a pending one can only come back switched on.
    const before = item.state === "pending" ? "enabled" : item.state;
    toast(t("masked.deleted", { email: item.email }), "success", undefined, {
      action: {
        label: t("toast.undo"),
        run: () => void change({ ...item, state: "deleted" }, { state: before }),
      },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Segmented
          label={t("masked.filter.label")}
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setEditing(null);
          }}
          options={MASKED_FILTERS.map((value) => ({
            value,
            label: (
              <>
                {t(`masked.filter.${value}`)} <span className="text-faint">{counts[value]}</span>
              </>
            ),
          }))}
        />
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.stopPropagation();
                event.preventDefault();
                setSearch("");
              }
            }}
            placeholder={t("masked.search")}
            aria-label={t("masked.search")}
            className="h-10 w-full rounded-full border border-transparent bg-canvas pr-10 pl-10 text-[13.5px] placeholder:text-muted focus:border-pink focus:bg-surface focus:shadow-focus focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <IconButton
              icon={X}
              size="sm"
              label={t("list.clearSearch")}
              onClick={() => setSearch("")}
              className="absolute top-1/2 right-1 -translate-y-1/2"
            />
          )}
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line px-4 py-3 text-[13px] text-muted">
          {search.trim() ? t("masked.noMatch") : t(`masked.emptyFilter.${filter}`)}
        </p>
      ) : (
        <ul className="flex flex-col gap-1 rounded-2xl border border-hairline p-1" aria-label={t("masked.title")}>
          {visible.map((item) =>
            editing === item.id ? (
              <MaskedEditor
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onDirty={onDirty}
                onCancel={() => setEditing(null)}
                onSave={async (patch) => {
                  if (Object.keys(patch).length === 0 || (await change(item, patch))) {
                    if (Object.keys(patch).length > 0) toast(t("masked.saved"), "success");
                    setEditing(null);
                  }
                }}
              />
            ) : (
              <MaskedRow
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onToggle={(on) => void change(item, { state: on ? "enabled" : "disabled" })}
                onEdit={() => setEditing(item.id)}
                onDelete={() => void remove(item)}
                onRestore={() =>
                  void change(item, { state: "enabled" }).then(
                    (ok) => ok && toast(t("masked.restored", { email: item.email }), "success"),
                  )
                }
              />
            ),
          )}
        </ul>
      )}
    </div>
  );
}

function MaskedRow({
  item,
  busy,
  onToggle,
  onEdit,
  onDelete,
  onRestore,
}: {
  item: MaskedAddress;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  const { t, i18n } = useT();
  const date = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { dateStyle: "medium" });
  const deleted = item.state === "deleted";
  const on = item.state === "enabled" || item.state === "pending";
  const site = siteLabel(item.forDomain);
  const link = openableUrl(item.url);
  const about = [item.description, site].filter(Boolean).join(" · ");

  return (
    <li className="flex items-start gap-2 rounded-xl py-2 pr-1 pl-3 hover:bg-elevated" aria-label={item.email}>
      {!deleted && (
        <span className="pt-1">
          <Switch
            size="sm"
            checked={on}
            disabled={busy}
            label={t("masked.onOff", { email: item.email })}
            onChange={onToggle}
          />
        </span>
      )}
      {/* On a phone the buttons go under the text, which keeps the whole width. */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
        <div className={clsx("flex min-w-0 flex-1 flex-col gap-0.5", !on && "opacity-70")}>
          <span className="selectable text-[13.5px] font-semibold break-all">{item.email}</span>
          {about && <span className="text-[12.5px] break-words text-ink">{about}</span>}
          <span className="text-[12px] text-muted">
            {t("masked.createdAt", { date: date(item.createdAt) })} ·{" "}
            {item.lastMessageAt ? t("masked.lastMessage", { date: date(item.lastMessageAt) }) : t("masked.noMessage")}
          </span>
          {item.state === "pending" && <span className="text-[12px] text-warning">{t("masked.pending")}</span>}
        </div>
        <div className="-ml-2 flex shrink-0 flex-wrap items-center sm:ml-0 sm:justify-end">
          <CopyButton email={item.email} />
          {link && (
            <IconButton
              icon={ExternalLink}
              size="sm"
              label={t("masked.openUrl", { email: item.email })}
              onClick={() => void openLinkNow(link)}
            />
          )}
          {deleted ? (
            <Button size="sm" variant="ghost" icon={RotateCcw} busy={busy} onClick={onRestore}>
              {t("masked.restore")}
            </Button>
          ) : (
            <>
              <IconButton icon={Pencil} size="sm" label={t("masked.edit", { email: item.email })} onClick={onEdit} />
              <IconButton
                icon={Trash}
                size="sm"
                label={t("masked.delete", { email: item.email })}
                disabled={busy}
                onClick={onDelete}
              />
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function MaskedEditor({
  item,
  busy,
  onDirty,
  onCancel,
  onSave,
}: {
  item: MaskedAddress;
  busy: boolean;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
  onSave: (patch: MaskedAddressPatch) => Promise<void>;
}) {
  const { t } = useT();
  const start: MaskedForm = { description: item.description, forDomain: item.forDomain, url: item.url ?? "" };
  const [form, setForm] = useState<MaskedForm>(start);
  const problems = maskedProblems(form);
  const next = maskedInput(form);
  const patch: MaskedAddressPatch = {
    ...(next.description !== item.description ? { description: next.description } : {}),
    ...(next.forDomain !== item.forDomain ? { forDomain: next.forDomain } : {}),
    ...(next.url !== item.url ? { url: next.url } : {}),
  };
  const dirty = form.description !== start.description || form.forDomain !== start.forDomain || form.url !== start.url;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);

  return (
    <li aria-label={item.email}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (Object.keys(problems).length === 0) void onSave(patch);
        }}
        className="flex flex-col gap-3 rounded-xl bg-canvas p-3"
      >
        <p className="text-[13.5px] font-semibold break-all">{item.email}</p>
        <DetailFields form={form} problems={problems} onChange={(change) => setForm({ ...form, ...change })} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" size="sm" busy={busy} disabled={Object.keys(problems).length > 0}>
            {t("common.save")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </li>
  );
}
