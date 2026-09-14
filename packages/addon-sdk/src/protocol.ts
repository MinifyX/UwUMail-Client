/**
 * Wire protocol between an addon frame and the UwUMail host. Stable across
 * minor versions; see docs/addons.md#wire-protocol.
 */

export const PROTOCOL_VERSION = 1;

export type ErrorCode =
  "permission_denied" | "not_found" | "invalid_params" | "rate_limited" | "host_not_allowed" | "internal";

export interface CallMessage {
  uwu: typeof PROTOCOL_VERSION;
  kind: "call";
  id: number;
  method: string;
  params: unknown[];
}

export interface ResultMessage {
  uwu: typeof PROTOCOL_VERSION;
  kind: "result";
  id: number;
  ok: boolean;
  value?: unknown;
  error?: { code: ErrorCode; message: string };
}

export interface EventMessage {
  uwu: typeof PROTOCOL_VERSION;
  kind: "event";
  name: string;
  payload: unknown;
}

export type AddonMessage = CallMessage;
export type HostMessage = ResultMessage | EventMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isCallMessage(value: unknown): value is CallMessage {
  return (
    isRecord(value) &&
    value.uwu === PROTOCOL_VERSION &&
    value.kind === "call" &&
    typeof value.id === "number" &&
    typeof value.method === "string" &&
    Array.isArray(value.params)
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  return isRecord(value) && value.uwu === PROTOCOL_VERSION && (value.kind === "result" || value.kind === "event");
}

export class AddonError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "AddonError";
    this.code = code;
  }
}
