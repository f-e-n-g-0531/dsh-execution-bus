/** Minimal structural view of a host session event; no host mutation or retry policy. */
export interface ModelWaitEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: unknown;
}

export type ModelWaitReason =
  | "budget"
  | "rate_limit"
  | "authentication"
  | "context_limit"
  | "transient"
  | "other";

/** Display-only observation, not a retry grant or evidence of model recovery. */
export interface ModelWaitStatus {
  provider: string;
  reason: ModelWaitReason;
  attempts: number;
  since: number;
  lastAt: number;
  nextRetryAt?: number;
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const ordinal = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 8.64e15;
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** Never read message, parse a provider body, or echo arbitrary failure fields. */
function reasonFor(value: unknown): ModelWaitReason | undefined {
  const failure = record(value);
  if (!failure) return;
  const code =
    typeof failure.code === "string" ? failure.code.toUpperCase() : "";
  const type =
    typeof failure.type === "string" ? failure.type.toUpperCase() : "";
  const status = failure.status;
  const has = (...codes: string[]) =>
    codes.includes(code) || codes.includes(type);
  if (
    status === 401 ||
    status === 403 ||
    has(
      "AUTHENTICATION_ERROR",
      "AUTHORIZATION_ERROR",
      "AUTHENTICATION",
      "PERMISSION_DENIED",
    )
  )
    return "authentication";
  if (
    status === 429 ||
    has("RATE_LIMIT", "RATE_LIMITED", "RATE_LIMIT_EXCEEDED")
  )
    return "rate_limit";
  if (
    has(
      "CONTEXT_LENGTH_EXCEEDED",
      "CONTEXT_LIMIT",
      "TOKEN_LIMIT",
      "TOKEN_LIMIT_EXCEEDED",
    )
  )
    return "context_limit";
  if (has("BUDGET_EXCEEDED", "INSUFFICIENT_QUOTA", "QUOTA_EXCEEDED"))
    return "budget";
  if (
    has("TIMEOUT", "NETWORK_ERROR", "SERVER_ERROR", "SERVICE_UNAVAILABLE") ||
    (typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 500 &&
      status <= 599)
  )
    return "transient";
  if (
    code ||
    type ||
    (typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599)
  )
    return "other";
}

/**
 * One instance per worker/session. Feed only its ordered host event stream.
 * Observes actual llm/retry events only; rc.1 does not guarantee their emission.
 * Absence of a status is not evidence of provider health or model availability.
 */
export class ModelWaitObserver {
  private seq = -1;
  private turn = -1;
  private step = -1;
  private ended = false;
  private settled = false;
  private chain?: { id: string; provider: string; retry: number };
  private readonly retired = new Set<string>();
  private status?: ModelWaitStatus;

  get(): ModelWaitStatus | undefined {
    return this.status ? { ...this.status } : undefined;
  }

  /** Preserve ordering and seal this step so late events cannot resurrect it. */
  clear(): void {
    this.status = undefined;
    this.settled = true;
  }

  private advance(turn: number, step: number): void {
    this.turn = turn;
    this.step = step;
    this.ended = false;
    this.settled = false;
    this.chain = undefined;
    this.status = undefined;
    this.retired.clear();
  }

  observe(event: ModelWaitEvent): void {
    if (!ordinal(event.seq) || !timestamp(event.time) || event.seq <= this.seq)
      return;
    this.seq = event.seq;
    const data = record(event.data);
    if (!data || !ordinal(data.turn) || data.turn < this.turn) return;
    if (event.type === "turn/start" || event.type === "turn/end") {
      if (data.turn > this.turn) this.advance(data.turn, -1);
      if (event.type === "turn/end") {
        this.clear();
        this.ended = true;
      }
      return;
    }
    // Starting an attempt is not model output and does not clear a wait.
    if (event.type === "llm/retry-started") return;
    if (
      !["step/start", "llm/retry", "assistant/message"].includes(event.type) ||
      !ordinal(data.step) ||
      (data.turn === this.turn && (this.ended || data.step < this.step))
    )
      return;

    if (event.type === "assistant/message") {
      const source = record(record(data.message)?.source);
      if (
        this.chain &&
        data.turn === this.turn &&
        data.step === this.step &&
        data.interrupted !== true &&
        source?.kind === "model" &&
        source.provider === this.chain.provider
      )
        this.clear();
      return;
    }
    if (event.type === "step/start") {
      if (data.turn > this.turn || data.step > this.step)
        this.advance(data.turn, data.step);
      return;
    }
    // Validate retry identity before letting it advance lifecycle watermarks.
    if (
      !identity(data.retryId) ||
      !identity(data.provider) ||
      !ordinal(data.retry) ||
      data.retry < 1
    )
      return;
    if (data.turn > this.turn || data.step > this.step)
      this.advance(data.turn, data.step);
    if (this.settled) return;
    const key = JSON.stringify([data.provider, data.retryId]);
    if (this.retired.has(key)) return;
    const same =
      this.chain?.id === data.retryId && this.chain.provider === data.provider;
    if (same && data.retry <= this.chain!.retry) return;
    if (this.chain && !same)
      this.retired.add(JSON.stringify([this.chain.provider, this.chain.id]));
    const previous = same ? this.status : undefined;
    this.chain = {
      id: data.retryId,
      provider: data.provider,
      retry: data.retry,
    };
    const reason = reasonFor(data.failure);
    if (!reason) {
      this.status = undefined;
      return;
    }
    this.status = {
      provider: /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(data.provider)
        ? data.provider
        : "unknown",
      reason,
      attempts: data.retry,
      since: previous?.since ?? event.time,
      lastAt: event.time,
    };
    if (ordinal(data.delayMs) && timestamp(event.time + data.delayMs))
      this.status.nextRetryAt = event.time + data.delayMs;
  }
}
