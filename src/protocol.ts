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
  /** 是否可安全复用终态结果。省略默认 true（可复用，向后兼容）；
   *  显式 false = 有副作用，终态结果复用将被拒绝（运行中等待仍放行）。 */
  readonly idempotent?: boolean;
  /** 调度队列类别；默认按 "default"。不同类别之间按类别优先级 + 等待老化排序，
   *  避免长任务类独占出队顺序。 */
  readonly queue?: string;
  /** 同一 Handler 同时在跑的上限；省略表示只受全局并发限制（舱壁）。 */
  readonly maxConcurrency?: number;
  /** 可选资源键（如文件路径）：同键请求在总线内互斥，避免并发写同一资源。
   *  由 Handler 在执行前从输入推导；返回空数组表示不占用资源。 */
  resources?(input: Record<string, unknown>): readonly string[];
  /** 唯一任务策略："payload" 表示幂等只读 Handler 可按 handler+input 指纹复用
   *  已成功的终态结果（不同 requestId）；省略表示只按 requestId 去重。 */
  readonly dedupe?: "payload";
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
  /** true 表示本次调用附着到已存在的逻辑执行，而不是新建执行（0.11.0 新增，可选）。 */
  reused?: true;
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
