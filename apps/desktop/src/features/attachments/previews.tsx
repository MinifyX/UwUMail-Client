import clsx from "clsx";
import { CalendarDays, Mail, MapPin, Phone, User } from "lucide-react";
import { useEffect, useState } from "react";
import type { AttachmentContent } from "@/backend/types";
import { useT } from "@/i18n";
import { parseCsv, parseIcs, parseVcf, type AttachmentKind } from "@/lib/attachments";

const TEXT_LIMIT = 1024 * 1024;
const CSV_ROWS = 500;

function useText(url: string) {
  const [state, setState] = useState<
    { url: string; text: string; truncated: boolean } | { url: string; error: string }
  >();
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((response) => response.text())
      .then((text) => {
        if (!cancelled) setState({ url, text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ url, error: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state?.url === url ? state : undefined;
}

function ImagePreview({ file }: { file: AttachmentContent }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <div className={clsx("h-full w-full overflow-auto", !zoomed && "grid place-items-center")}>
      <img
        src={file.url}
        alt={file.filename}
        onClick={() => setZoomed(!zoomed)}
        className={clsx(
          "select-none",
          zoomed ? "max-w-none cursor-zoom-out" : "max-h-full max-w-full cursor-zoom-in object-contain",
        )}
      />
    </div>
  );
}

function TextPreview({ file, kind }: { file: AttachmentContent; kind: "text" | "json" | "csv" }) {
  const { t } = useT();
  const state = useText(file.url);
  if (!state) return <p className="p-6 text-[13px] text-muted">{t("attachment.loading")}</p>;
  if ("error" in state) return <p className="p-6 text-[13px] text-danger">{state.error}</p>;

  if (kind === "csv") {
    const rows = parseCsv(state.text, CSV_ROWS);
    const [head, ...body] = rows;
    return (
      <div className="h-full overflow-auto p-4">
        <table className="selectable w-max min-w-full border-collapse text-[13px]">
          {head && (
            <thead className="sticky top-0 bg-elevated">
              <tr>
                {head.map((cell, index) => (
                  <th key={index} className="border border-line px-3 py-2 text-left font-bold">
                    {cell}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className="odd:bg-canvas/60">
                {row.map((cell, index) => (
                  <td key={index} className="border border-line px-3 py-1.5 whitespace-pre-wrap">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length >= CSV_ROWS && (
          <p className="pt-3 text-[12px] text-muted">{t("attachment.tableTruncated", { count: CSV_ROWS })}</p>
        )}
      </div>
    );
  }

  let content = state.text;
  if (kind === "json") {
    try {
      content = JSON.stringify(JSON.parse(state.text), null, 2);
    } catch {
      // Not valid JSON: show it as it is.
    }
  }
  return (
    <div className="h-full overflow-auto p-5">
      <pre className="selectable font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-ink">{content}</pre>
      {state.truncated && <p className="pt-3 text-[12px] text-muted">{t("attachment.textTruncated")}</p>}
    </div>
  );
}

function CalendarPreview({ file }: { file: AttachmentContent }) {
  const { t, i18n } = useT();
  const state = useText(file.url);
  if (!state) return <p className="p-6 text-[13px] text-muted">{t("attachment.loading")}</p>;
  if ("error" in state) return <p className="p-6 text-[13px] text-danger">{state.error}</p>;
  const events = parseIcs(state.text);
  const format = (value: { date: Date; allDay: boolean } | null) =>
    value
      ? value.allDay
        ? value.date.toLocaleDateString(i18n.language, { dateStyle: "full" })
        : value.date.toLocaleString(i18n.language, { dateStyle: "full", timeStyle: "short" })
      : "";

  return (
    <div className="grid h-full content-start justify-items-center gap-4 overflow-auto p-6">
      {events.map((event, index) => (
        <article
          key={index}
          className="selectable w-full max-w-[520px] rounded-[20px] border border-line bg-surface p-6"
        >
          <p className="flex items-center gap-2 text-[12px] font-bold tracking-wide text-pink-ink uppercase">
            <CalendarDays className="size-4" aria-hidden />
            {event.method === "REQUEST" ? t("attachment.invitation") : t("attachment.event")}
          </p>
          <h3 className="pt-2 text-[20px] font-extrabold">{event.summary}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 pt-4 text-[14px]">
            <dt className="text-muted">{t("attachment.when")}</dt>
            <dd>
              {format(event.start)}
              {event.end &&
                !event.end.allDay &&
                ` – ${event.end.date.toLocaleTimeString(i18n.language, { timeStyle: "short" })}`}
            </dd>
            {event.location && (
              <>
                <dt className="text-muted">{t("attachment.where")}</dt>
                <dd className="flex items-center gap-1.5">
                  <MapPin className="size-4 text-muted" aria-hidden />
                  {event.location}
                </dd>
              </>
            )}
            {event.organizer && (
              <>
                <dt className="text-muted">{t("attachment.organizer")}</dt>
                <dd>{event.organizer}</dd>
              </>
            )}
          </dl>
          {event.description && (
            <p className="mt-4 border-t border-hairline pt-4 text-[14px] whitespace-pre-wrap text-muted">
              {event.description}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

function ContactPreview({ file }: { file: AttachmentContent }) {
  const { t } = useT();
  const state = useText(file.url);
  if (!state) return <p className="p-6 text-[13px] text-muted">{t("attachment.loading")}</p>;
  if ("error" in state) return <p className="p-6 text-[13px] text-danger">{state.error}</p>;
  return (
    <div className="grid h-full content-start justify-items-center gap-4 overflow-auto p-6">
      {parseVcf(state.text).map((card, index) => (
        <article
          key={index}
          className="selectable flex w-full max-w-[420px] flex-col items-center gap-3 rounded-[20px] border border-line bg-surface p-6 text-center"
        >
          <span className="grid size-16 place-items-center rounded-full bg-pink-tint text-pink-ink">
            <User className="size-7" aria-hidden />
          </span>
          <div>
            <h3 className="text-[20px] font-extrabold">{card.name}</h3>
            {(card.title || card.organization) && (
              <p className="text-[14px] text-muted">{[card.title, card.organization].filter(Boolean).join(" · ")}</p>
            )}
          </div>
          <ul className="flex w-full flex-col gap-2 pt-2 text-[14px]">
            {card.emails.map((email) => (
              <li key={email} className="flex items-center gap-2 rounded-xl bg-canvas px-3 py-2">
                <Mail className="size-4 text-muted" aria-label={t("attachment.email")} />
                {email}
              </li>
            ))}
            {card.phones.map((phone) => (
              <li key={phone} className="flex items-center gap-2 rounded-xl bg-canvas px-3 py-2">
                <Phone className="size-4 text-muted" aria-label={t("attachment.phone")} />
                {phone}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

export function AttachmentPreview({ file, kind }: { file: AttachmentContent; kind: AttachmentKind }) {
  const { t } = useT();
  switch (kind) {
    case "image":
      return <ImagePreview file={file} />;
    case "pdf":
      return (
        <div className="flex h-full flex-col">
          <iframe src={file.url} title={file.filename} className="min-h-0 w-full flex-1 border-0 bg-white" />
          <p className="px-4 py-2 text-center text-[12px] text-muted">{t("attachment.pdfHint")}</p>
        </div>
      );
    case "text":
    case "json":
    case "csv":
      return <TextPreview file={file} kind={kind} />;
    case "audio":
      return (
        <div className="grid h-full place-items-center p-6">
          <audio src={file.url} controls className="w-full max-w-[520px]" />
        </div>
      );
    case "video":
      return (
        <div className="grid h-full place-items-center bg-black">
          <video src={file.url} controls className="max-h-full max-w-full" />
        </div>
      );
    case "calendar":
      return <CalendarPreview file={file} />;
    case "contact":
      return <ContactPreview file={file} />;
    case "other":
      return null;
  }
}
