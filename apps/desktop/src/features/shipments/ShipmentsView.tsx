import {
  Button,
  EmptyState,
  Field,
  Hint,
  Icon,
  IconButton,
  ICONS,
  Menu,
  Select,
  Tag,
  TextInput,
} from "@uwusuite/design";
import clsx from "clsx";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { CARRIERS, type Shipment, type ShipmentCarrier, type ShipmentEvent } from "@/backend/types";
import { NyuScene } from "@/components/nyu/scenes";
import { Dialog } from "@/components/ui/Dialog";
import { useNow } from "@/features/verification/useVerificationCodes";
import { useT } from "@/i18n";
import { accountLabel } from "@/lib/accountLabel";
import { addDays, todayKey } from "@/lib/calendarDates";
import { useIsPhone } from "@/lib/device";
import { sinceText } from "@/lib/format";
import { openExternal } from "@/lib/platform";
import { useVisibleAccounts } from "@/lib/queries";
import { dayOf, finishedAt, groupShipments, isActive, markable, shipmentKey, STEPS, stepOf } from "@/lib/shipments";
import { useUi } from "@/state/ui";
import { useHiddenShipments, useShipmentActions, useShipmentFocus, useShipments } from "./useShipments";

type T = ReturnType<typeof useT>["t"];

/** A bare date as the local day it names, anything else as the instant it is. */
function toDate(value: string): Date {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
}

const isBareDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

function dayText(value: string, t: T, locale: string): string {
  const day = dayOf(value);
  const today = todayKey();
  if (day === today) return t("shipments.day.today");
  if (day === addDays(today, 1)) return t("shipments.day.tomorrow");
  return toDate(value).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
}

const timeText = (value: string, locale: string) =>
  toDate(value).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

/** "Today, 10:15–12:15", "Tomorrow", "Thu, 19 Nov, from 14:00". */
function whenText(expected: NonNullable<Shipment["expected"]> & { from: string }, t: T, locale: string): string {
  const day = dayText(expected.from, t, locale);
  if (expected.allDay || isBareDate(expected.from)) return day;
  const from = timeText(expected.from, locale);
  return expected.to
    ? t("shipments.window", { day, from, to: timeText(expected.to, locale) })
    : t("shipments.from", { day, from });
}

function sourceText(event: ShipmentEvent, t: T): string {
  if (event.source === "mail") return t("shipments.source.mail");
  if (event.source === "ai") return t("shipments.source.ai");
  if (event.source === "carrier") return t("shipments.source.carrier");
  return event.clientName ?? t("shipments.source.client");
}

const cardTitle = (shipment: Shipment, t: T) =>
  shipment.title ?? shipment.merchant ?? t(`shipments.carrier.${shipment.carrier}`);

/** The parcels, in "Today", "On the way" and the last week's deliveries. */
export function ShipmentsView() {
  const { t } = useT();
  const phone = useIsPhone();
  const { data: shipments, isLoading } = useShipments();
  const { data: hidden = [] } = useHiddenShipments();
  const [adding, setAdding] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const groups = groupShipments(shipments ?? []);
  const empty = !isLoading && groups.today.length + groups.onTheWay.length + groups.delivered.length === 0;

  const body = (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-4 pb-8 sm:px-6">
      <header className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-large leading-tight font-extrabold tracking-[-0.02em]">
          {t("nav.section.shipments")}
        </h1>
        <Button icon={ICONS.add} size="sm" onClick={() => setAdding(true)}>
          {t("shipments.add")}
        </Button>
      </header>
      {empty ? (
        <EmptyState
          art={<NyuScene name="emptyFolder" />}
          title={t("shipments.empty.title")}
          body={t("shipments.empty.body")}
        />
      ) : (
        <>
          <Group title={t("shipments.group.today")} items={groups.today} />
          <Group title={t("shipments.group.onTheWay")} items={groups.onTheWay} />
          <Group title={t("shipments.group.delivered")} items={groups.delivered} />
        </>
      )}
      {hidden.length > 0 && (
        <div className="flex flex-col gap-3">
          <Button
            size="sm"
            variant="ghost"
            icon={showHidden ? ICONS.hide : ICONS.show}
            className="self-center"
            aria-expanded={showHidden}
            onClick={() => setShowHidden((v) => !v)}
          >
            {t(showHidden ? "shipments.hiddenHide" : "shipments.hiddenShow", { n: hidden.length })}
          </Button>
          {showHidden && <Group title={t("shipments.group.hidden")} items={hidden} />}
        </div>
      )}
      <AddShipment open={adding} onClose={() => setAdding(false)} />
    </div>
  );

  return phone ? (
    <section aria-label={t("nav.section.shipments")} className="h-full overflow-y-auto bg-surface">
      {body}
    </section>
  ) : (
    <div className="flex min-h-0 flex-1 py-2 pr-3 pb-3">
      <section
        aria-label={t("nav.section.shipments")}
        className="min-w-0 flex-1 overflow-y-auto rounded-[22px] border border-hairline bg-surface"
      >
        {body}
      </section>
    </div>
  );
}

function Group({ title, items }: { title: string; items: Shipment[] }) {
  const id = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-meta font-semibold text-muted">
        {title} <span className="font-normal">({items.length})</span>
      </h2>
      <ul className="flex flex-col gap-3">
        {items.map((shipment) => (
          <li key={shipmentKey(shipment)}>
            <ShipmentCard shipment={shipment} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatusTag({ shipment }: { shipment: Shipment }) {
  const { t } = useT();
  const tone =
    shipment.status === "delivered"
      ? "success"
      : shipment.status === "deliveryFailed" || shipment.status === "returned"
        ? "warning"
        : shipment.status === "cancelled"
          ? "danger"
          : "neutral";
  return <Tag tone={tone}>{t(`shipments.status.${shipment.status}`)}</Tag>;
}

/** Ordered → shipped → on its way → out for delivery → delivered, the current step named. */
function Progress({ shipment }: { shipment: Shipment }) {
  const { t } = useT();
  const step = stepOf(shipment.status);
  const failed = shipment.status === "deliveryFailed";
  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label={t("shipments.progress")}>
      {STEPS.map((status, index) => {
        const current = index === step;
        return (
          <li key={status} aria-current={current ? "step" : undefined} className="flex min-w-0 flex-col gap-1">
            <span
              aria-hidden
              className={clsx(
                "h-1.5 rounded-full",
                index > step ? "bg-hairline" : current && failed ? "bg-warning" : "bg-success",
              )}
            />
            <span
              className={clsx(
                // On phones the status tag above already names the step; the bars alone fit.
                "text-caption hyphens-auto max-sm:sr-only",
                current ? "font-semibold text-ink" : "text-muted",
                index > step && "sm:text-faint",
              )}
            >
              {current && (shipment.status === "readyForPickup" || failed)
                ? t(`shipments.status.${shipment.status}`)
                : t(`shipments.status.${status}`)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ShipmentCard({ shipment }: { shipment: Shipment }) {
  const { t, i18n } = useT();
  const locale = i18n.language;
  const actions = useShipmentActions();
  const focusKey = useShipmentFocus((s) => s.key);
  const key = shipmentKey(shipment);
  const ref = useRef<HTMLElement>(null);
  const headingId = useId();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const active = isActive(shipment);
  const latest = shipment.events.at(-1);
  const marks = markable(shipment.status);

  useEffect(() => {
    if (focusKey !== key || !ref.current) return;
    ref.current.scrollIntoView({ block: "center" });
    ref.current.focus({ preventScroll: true });
    useShipmentFocus.getState().set(null);
  }, [focusKey, key]);

  const mail = shipment.emailIds.at(-1);
  const sub = [
    t(`shipments.carrier.${shipment.carrier}`),
    shipment.title && shipment.merchant,
    shipment.orderRef && t("shipments.order", { ref: shipment.orderRef }),
  ].filter(Boolean);

  return (
    <article
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-card border border-hairline bg-surface p-4 focus-visible:shadow-focus focus-visible:outline-hidden"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-control bg-canvas text-muted">
          <Icon icon={ICONS.parcel} size="lg" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="truncate text-body font-semibold">
            {cardTitle(shipment, t)}
          </h3>
          <p className="truncate text-meta text-muted">{sub.join(" · ")}</p>
        </div>
        <StatusTag shipment={shipment} />
      </div>

      {active && shipment.status !== "readyForPickup" && shipment.expected?.from && (
        <p className="text-reading">
          <span className="text-muted">{t("shipments.expected")}</span>{" "}
          <span className="font-semibold">
            {whenText({ ...shipment.expected, from: shipment.expected.from }, t, locale)}
          </span>
        </p>
      )}
      {!active && (
        <p className="text-meta text-muted">
          {t(`shipments.finished.${shipment.status}`, { date: dayText(finishedAt(shipment), t, locale) })}
        </p>
      )}

      {shipment.status === "returned" || shipment.status === "cancelled" ? null : <Progress shipment={shipment} />}

      {shipment.status === "readyForPickup" && shipment.pickup && (
        <Hint tone="info">
          <p className="font-semibold">
            {t(`shipments.pickup.${shipment.pickup.kind}`, { defaultValue: t("shipments.pickup.parcelShop") })}
            {shipment.pickup.name && `: ${shipment.pickup.name}`}
          </p>
          {shipment.pickup.address && <p>{shipment.pickup.address}</p>}
          {shipment.pickup.until && (
            <p className="font-semibold">
              {t("shipments.pickup.until", {
                date: toDate(shipment.pickup.until).toLocaleDateString(locale, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                }),
              })}
            </p>
          )}
        </Hint>
      )}
      {shipment.status === "deliveryFailed" && <Hint tone="warning">{latest?.text || t("shipments.failedHint")}</Hint>}

      {shipment.number && (
        <p className="text-meta text-muted">
          {t("shipments.number")} <span className="selectable font-mono text-ink">{shipment.number}</span>
        </p>
      )}

      {(shipment.lookedUpAt || shipment.lookupError) && (
        <p className="text-caption text-muted">
          {shipment.lookedUpAt && <LookedUp at={shipment.lookedUpAt} />}
          {shipment.lookedUpAt && shipment.lookupError && " · "}
          {shipment.lookupError && t(`shipments.lookupError.${shipment.lookupError}`)}
        </p>
      )}

      {shipment.events.length > 0 && (
        <details className="group text-meta">
          <summary className="cursor-pointer rounded-control font-semibold text-muted hover:text-ink">
            {t("shipments.history", { n: shipment.events.length })}
          </summary>
          <ol className="mt-2 flex flex-col gap-2 border-l border-hairline pl-3">
            {[...shipment.events].reverse().map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <p className="text-ink">
                  {event.text || (event.status ? t(`shipments.status.${event.status}`) : "")}
                  {event.location && <span className="text-muted"> · {event.location}</span>}
                </p>
                <p className="text-caption text-muted">
                  <time dateTime={event.at}>
                    {new Date(event.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                  </time>{" "}
                  · {t("shipments.via", { source: sourceText(event, t) })}
                </p>
              </li>
            ))}
          </ol>
        </details>
      )}

      <div className="-mb-1 flex flex-wrap items-center gap-2">
        {shipment.trackingUrl && (
          <Button
            size="sm"
            variant="secondary"
            icon={ICONS.openExternal}
            onClick={() => void openExternal(shipment.trackingUrl!)}
          >
            {t("shipments.track")}
            <span className="sr-only">{t("shipments.inBrowser")}</span>
          </Button>
        )}
        {shipment.shopTrackingUrl && (
          <Button
            size="sm"
            variant="secondary"
            icon={ICONS.openExternal}
            onClick={() => void openExternal(shipment.shopTrackingUrl!)}
          >
            {t("shipments.trackAtShop")}
            <span className="sr-only">{t("shipments.inBrowser")}</span>
          </Button>
        )}
        {shipment.refreshable && (
          <Button
            size="sm"
            variant="ghost"
            icon={ICONS.refresh}
            busy={lookingUp}
            onClick={() => {
              setLookingUp(true);
              void actions.lookUp(shipment).finally(() => setLookingUp(false));
            }}
          >
            {t("shipments.lookUp")}
          </Button>
        )}
        {mail && (
          <Button
            size="sm"
            variant="ghost"
            icon={ICONS.mail}
            onClick={() => {
              const ui = useUi.getState();
              ui.setSection("mail");
              ui.selectThread(`m:${mail}`);
            }}
          >
            {t("shipments.toMail")}
          </Button>
        )}
        {shipment.hidden && (
          <Button size="sm" variant="ghost" icon={ICONS.show} onClick={() => void actions.unhide(shipment)}>
            {t("shipments.unhide")}
          </Button>
        )}
        <span className="flex-1" />
        <Menu
          align="end"
          items={[
            ...(marks.length > 0
              ? [
                  { heading: t("shipments.mark") },
                  ...marks.map((status) => ({
                    label: t(`shipments.status.${status}`),
                    onSelect: () => void actions.mark(shipment, status),
                  })),
                  "separator" as const,
                ]
              : []),
            { label: t("shipments.rename"), icon: ICONS.edit, onSelect: () => setRenaming(true) },
            ...(shipment.hidden
              ? []
              : [{ label: t("shipments.hide"), icon: ICONS.hide, onSelect: () => void actions.hide(shipment) }]),
            "separator",
            { label: t("shipments.delete"), icon: ICONS.delete, danger: true, onSelect: () => setDeleting(true) },
          ]}
          trigger={(menu) => (
            <IconButton
              icon={ICONS.more}
              size="sm"
              label={t("shipments.actions", { name: cardTitle(shipment, t) })}
              onClick={menu.toggle}
              aria-haspopup={menu["aria-haspopup"]}
              aria-expanded={menu["aria-expanded"]}
              aria-controls={menu["aria-controls"]}
            />
          )}
        />
      </div>

      {renaming && <RenameShipment shipment={shipment} onClose={() => setRenaming(false)} />}
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t("shipments.deleteTitle")}
        width="sm"
        tone="warning"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setDeleting(false);
                void actions.remove(shipment);
              }}
            >
              {t("shipments.delete")}
            </Button>
          </>
        }
      >
        <p className="text-reading">{t("shipments.deleteBody", { name: cardTitle(shipment, t) })}</p>
      </Dialog>
    </article>
  );
}

/** "Last checked 5 min ago", kept up to date. */
function LookedUp({ at }: { at: string }) {
  const { t, i18n } = useT();
  const now = useNow(true, 30_000);
  return <time dateTime={at}>{t("shipments.lookedUp", { when: sinceText(Date.parse(at), now, i18n.language) })}</time>;
}

function RenameShipment({ shipment, onClose }: { shipment: Shipment; onClose: () => void }) {
  const { t } = useT();
  const actions = useShipmentActions();
  const [title, setTitle] = useState(shipment.title ?? "");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    if (await actions.rename(shipment, title.trim() || null)) onClose();
    setBusy(false);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("shipments.rename")}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={busy}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(event) => void submit(event)}>
        <Field label={t("shipments.name")} hint={t("shipments.nameHint")}>
          {(id, describedBy) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={title}
              maxLength={200}
              autoFocus
              placeholder={shipment.merchant ?? ""}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

function AddShipment({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT();
  const actions = useShipmentActions();
  // Shared mailboxes keep no parcels of their own.
  const accounts = useVisibleAccounts().accounts.filter((account) => !account.parentId);
  const [chosen, setChosen] = useState<string | null>(null);
  const accountId = chosen && accounts.some((a) => a.id === chosen) ? chosen : accounts[0]?.id;
  const [carrier, setCarrier] = useState<ShipmentCarrier>("dhl");
  const [number, setNumber] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const formId = useId();
  const close = () => {
    setNumber("");
    setTitle("");
    setMissing(false);
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!number.trim()) {
      setMissing(true);
      return;
    }
    if (!accountId) return;
    setBusy(true);
    if (await actions.add({ accountId, carrier, number, title })) close();
    setBusy(false);
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("shipments.add")}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={busy}>
            {t("shipments.addButton")}
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        {accounts.length > 1 && (
          <Field label={t("shipments.account")}>
            {(id) => (
              <Select id={id} value={accountId} onChange={(event) => setChosen(event.target.value)}>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t("shipments.carrierLabel")}>
          {(id) => (
            <Select id={id} value={carrier} onChange={(event) => setCarrier(event.target.value as ShipmentCarrier)}>
              {CARRIERS.map((value) => (
                <option key={value} value={value}>
                  {t(`shipments.carrier.${value}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("shipments.number")} error={missing ? t("shipments.numberMissing") : undefined}>
          {(id, describedBy) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              aria-invalid={missing || undefined}
              required
              value={number}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setNumber(event.target.value);
                setMissing(false);
              }}
            />
          )}
        </Field>
        <Field label={t("shipments.nameOptional")}>
          {(id) => (
            <TextInput id={id} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
