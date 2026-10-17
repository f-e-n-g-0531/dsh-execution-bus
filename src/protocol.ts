import { assertJson } from "./json.js";
import { ERRORS } from "./error-codes.js";
import { LIMITS } from "./limits.js";

export type State =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";
export type Owner = { sessionId: string; callId: string };
export type Message = {
  protocolVersion: 1;
  messageId: string;
  requestId: string;
  type: "request" | "status" | "result" | "cancel";
  payload: Record<string, unknown>;
};
export type Event = {
  protocolVersion: 1;
  messageId: string;
  requestId: string;
  correlationId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
};
export type Capability = (
  input: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
export interface Handler {
  validate(input: Record<string, unknown>): void;
  run(
    input: Record<string, unknown>,
    ctx: {
      signal: AbortSignal;
      progress: (sequence: number, percent: number) => void;
      requestId: string;
      invoke?: Capability;
    },
  ): Promise<unknown>;
}
export interface RecordView {
  requestId: string;
  state: State;
  sequence: number;
  cancelRequested: boolean;
  delivery: "pending" | "returned";
  result?: unknown;
  error?: string;
  progress?: number;
}

export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error(ERRORS.INVALID_OBJECT);
  return v as Record<string, unknown>;
}

/** 规范排序后的稳定摘要，只用于同 requestId 的冲突比较，不用于跨请求去重。 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonical((v as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

export function parse(raw: unknown): Message {
  assertJson(raw);
  const m = object(raw);
  if (
    Object.keys(m).some(
      (k) =>
        ![
          "protocolVersion",
          "messageId",
          "requestId",
          "type",
          "payload",
        ].includes(k),
    )
  )
    throw Error(ERRORS.UNKNOWN_FIELD);
  if (m.protocolVersion !== 1) throw Error(ERRORS.UNSUPPORTED_VERSION);
  for (const k of ["messageId", "requestId"])
    if (typeof m[k] !== "string" || !LIMITS.idPattern.test(m[k] as string))
      throw Error(ERRORS.INVALID_ID);
  if (!["request", "status", "result", "cancel"].includes(m.type as string))
    throw Error(ERRORS.UNSUPPORTED_TYPE);
  object(m.payload);
  if (Buffer.byteLength(JSON.stringify(m)) > LIMITS.messageMaxBytes)
    throw Error(ERRORS.MESSAGE_TOO_LARGE);
  return structuredClone(m) as Message;
}

export function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
