import { randomUUID, createHash } from "node:crypto";
import { assertJson } from "./json.js";
import { Diagnostics } from "./diagnostics.js";
import { performance } from "node:perf_hooks";
import { CORE_DEFAULTS } from "./product.js";
export interface AdmissionPolicy {
  sessionQueueLimit?: number;
  maxQueueWaitMs?: number;
}
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
interface Entry {
  trace: { operation: number; at: number };
  resultBytes: number;
  deadline?: number;
  queueTimer?: ReturnType<typeof setTimeout>;
  startedAt?: number;
  finishedAt?: number;
  invoke?: Capability;
  correlationId: string;
  owner: string;
  fingerprint: string;
  handler: Handler;
  input: Record<string, unknown>;
  view: RecordView;
  controller: AbortController;
  done: Promise<RecordView>;
  resolve: (v: RecordView) => void;
  listeners: Set<(e: Event) => void>;
  notifications: { event: Event; listeners: ((e: Event) => void)[] }[];
  dispatching: boolean;
  sourceSequence: number;
  created: number;
  messages: Map<string, string>;
}
export function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("INVALID_OBJECT");
  return v as Record<string, unknown>;
}
function canonical(v: unknown): string {
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
    throw Error("UNKNOWN_FIELD");
  if (m.protocolVersion !== 1) throw Error("UNSUPPORTED_VERSION");
  for (const k of ["messageId", "requestId"])
    if (
      typeof m[k] !== "string" ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(m[k] as string)
    )
      throw Error("INVALID_ID");
  if (!["request", "status", "result", "cancel"].includes(m.type as string))
    throw Error("UNSUPPORTED_TYPE");
  object(m.payload);
  if (Buffer.byteLength(JSON.stringify(m)) > 16384)
    throw Error("MESSAGE_TOO_LARGE");
  return structuredClone(m) as Message;
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
const terminal = (s: State) => !["queued", "running"].includes(s);
/** Volatile single-process bus; no acceptance durability or automatic execution retry. */
export class ExecutionBus {
  private entries = new Map<string, Entry>();
  private handlers = new Map<string, { handler: Handler; token: symbol }>();
  private queue: Entry[] = [];
  private readyOwners: string[] = [];
  private running = 0;
  private retainedResultBytes = 0;
  private closed = false;
  private telemetry = new Diagnostics();
  diagnostics() {
    return {
      ...this.telemetry.snapshot(),
      phase: this.shutdownPhase,
      queued: this.queue.length,
      running: this.running,
      records: this.entries.size,
      retainedResultBytes: this.retainedResultBytes,
    };
  }
  private closing?: Promise<void>;
  private shutdownPhase: "open" | "cancelling" | "draining" | "closed" = "open";
  constructor(
    readonly options: {
      concurrency: number;
      queueLimit: number;
      recordLimit: number;
      resultBytes: number;
      retentionMs: number;
    } = CORE_DEFAULTS,
    readonly admission: AdmissionPolicy = {},
  ) {
    const allowed = ["sessionQueueLimit", "maxQueueWaitMs"];
    if (
      !admission ||
      typeof admission !== "object" ||
      Array.isArray(admission) ||
      Reflect.ownKeys(admission).some(
        (key) => typeof key !== "string" || !allowed.includes(key),
      )
    )
      throw Error("INVALID_ADMISSION_POLICY");
    for (const key of Reflect.ownKeys(admission)) {
      const descriptor = Object.getOwnPropertyDescriptor(admission, key)!;
      if (
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !Number.isSafeInteger(descriptor.value) ||
        descriptor.value < 1 ||
        descriptor.value > 2147483647
      )
        throw Error("INVALID_ADMISSION_POLICY");
    }
    this.admission = Object.freeze({ ...admission });
    const keys = [
      "concurrency",
      "queueLimit",
      "recordLimit",
      "resultBytes",
      "retentionMs",
    ];
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Reflect.ownKeys(options).length !== keys.length ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        return (
          !descriptor || !("value" in descriptor) || !descriptor.enumerable
        );
      })
    )
      throw Error("INVALID_OPTIONS");
    this.options = Object.freeze({ ...options });
    for (const v of Object.values(this.options))
      if (!Number.isSafeInteger(v) || v < 1) throw Error("INVALID_OPTIONS");
  }
  register(name: string, handler: Handler) {
    if (this.handlers.has(name)) throw Error("DUPLICATE_HANDLER");
    const registration = { handler, token: Symbol(name) };
    this.handlers.set(name, registration);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.handlers.get(name)?.token === registration.token)
        this.handlers.delete(name);
    };
  }
  private key(o: Owner, id: string) {
    if (!o.sessionId || !o.callId) throw Error("UNTRUSTED_CONTEXT");
    return JSON.stringify([o.sessionId, id]);
  }
  private emit(
    e: Entry,
    type: string,
    payload: Record<string, unknown>,
    correlationId = "",
  ) {
    e.view.sequence++;
    const event: Event = freezeJson({
      protocolVersion: 1,
      messageId: randomUUID(),
      requestId: e.view.requestId,
      correlationId: correlationId || e.correlationId,
      sequence: e.view.sequence,
      type,
      payload,
    });
    // Snapshot and enqueue before invoking user code: nested cancellation cannot
    // overtake the current event for later observers. Removed listeners are skipped.
    e.notifications.push({ event, listeners: [...e.listeners] });
    if (e.dispatching) return;
    e.dispatching = true;
    try {
      while (e.notifications.length) {
        const batch = e.notifications.shift()!;
        for (const listener of batch.listeners) {
          if (!e.listeners.has(listener)) continue;
          try {
            void Promise.resolve(listener(batch.event)).catch(() => {});
          } catch {}
        }
      }
    } finally {
      e.dispatching = false;
      if (terminal(e.view.state)) e.listeners.clear();
    }
  }
  private view(e: Entry) {
    return structuredClone(e.view);
  }
  private get(o: Owner, id: string) {
    const e = this.entries.get(this.key(o, id));
    if (!e) throw Error("NOT_FOUND");
    return e;
  }
  sweep(now = Date.now()) {
    for (const [k, e] of this.entries)
      if (
        terminal(e.view.state) &&
        now - e.created > this.options.retentionMs
      ) {
        this.retainedResultBytes -= e.resultBytes;
        this.entries.delete(k);
      }
  }
  submit(
    owner: Owner,
    raw: unknown,
    onEvent?: (e: Event) => void,
    invoke?: Capability,
  ) {
    if (this.closed) throw Error("CLOSED");
    const m = parse(raw);
    if (m.type !== "request") throw Error("EXPECTED_REQUEST");
    const p = m.payload;
    if (
      Object.keys(p).some((k) => !["handler", "input"].includes(k)) ||
      typeof p.handler !== "string"
    )
      throw Error("INVALID_REQUEST");
    const input = object(p.input);
    const key = this.key(owner, m.requestId),
      fp = createHash("sha256").update(canonical(p)).digest("hex");
    this.sweep();
    let e = this.entries.get(key);
    if (e) {
      if (e.fingerprint !== fp) throw Error("REQUEST_CONFLICT");
      const previous = e.messages.get(m.messageId);
      if (previous && previous !== canonical(m))
        throw Error("MESSAGE_CONFLICT");
      if (!previous && e.messages.size >= 128) throw Error("MESSAGE_LIMIT");
      // Acquire the attachment before committing its message identity. Rejection is side-effect free.
      const attached = this.attachment(e, onEvent, m.messageId);
      if (!previous) e.messages.set(m.messageId, canonical(m));
      this.telemetry.record(e.trace, "reused");
      return attached;
    }
    const handler = this.handlers.get(p.handler)?.handler;
    if (!handler) throw Error("UNKNOWN_HANDLER");
    handler.validate(input);
    if (
      this.entries.size >= this.options.recordLimit ||
      this.queue.length >= this.options.queueLimit
    )
      throw Error("BACKPRESSURE");
    if (
      this.admission.sessionQueueLimit !== undefined &&
      this.queue.filter((entry) => entry.owner === owner.sessionId).length >=
        this.admission.sessionQueueLimit
    )
      throw Error("SESSION_BACKPRESSURE");
    let resolve!: (v: RecordView) => void;
    const done = new Promise<RecordView>((r) => (resolve = r));
    e = {
      trace: this.telemetry.begin(),
      resultBytes: 0,
      invoke,
      correlationId: m.messageId,
      owner: owner.sessionId,
      fingerprint: fp,
      handler,
      input: structuredClone(input),
      view: {
        requestId: m.requestId,
        state: "queued",
        sequence: 0,
        cancelRequested: false,
        delivery: "pending",
      },
      controller: new AbortController(),
      done,
      resolve,
      listeners: new Set(),
      notifications: [],
      dispatching: false,
      sourceSequence: 0,
      created: Date.now(),
      messages: new Map([[m.messageId, canonical(m)]]),
    };
    this.entries.set(key, e);
    this.telemetry.record(e.trace, "accepted");
    const attached = this.attachment(e, onEvent, m.messageId);
    this.queue.push(e);
    if (this.admission.maxQueueWaitMs !== undefined) {
      e.deadline = performance.now() + this.admission.maxQueueWaitMs;
      const entry = e;
      const expire = () => {
        if (entry.view.state !== "queued") return;
        const remaining = entry.deadline! - performance.now();
        if (remaining > 0) {
          entry.queueTimer = setTimeout(expire, Math.ceil(remaining));
          return;
        }
        this.removeQueued(entry);
        this.finish(entry, "failed", undefined, "QUEUE_WAIT_TIMEOUT");
      };
      e.queueTimer = setTimeout(expire, this.admission.maxQueueWaitMs);
    }
    if (!this.readyOwners.includes(e.owner)) this.readyOwners.push(e.owner);
    queueMicrotask(() => this.pump());
    return attached;
  }
  private attachment(
    e: Entry,
    onEvent: ((e: Event) => void) | undefined,
    id: string,
  ) {
    // Each attachment owns its registration, even when callers reuse one function.
    const listener = onEvent ? (event: Event) => onEvent(event) : undefined;
    if (listener && !terminal(e.view.state)) {
      if (e.listeners.size >= 32) throw Error("WAITER_LIMIT");
      e.listeners.add(listener);
    }
    const accepted: Event = {
      protocolVersion: 1,
      messageId: randomUUID(),
      requestId: e.view.requestId,
      correlationId: id,
      sequence: e.view.sequence,
      type: "accepted",
      payload: { state: e.view.state, durable: false },
    };
    return {
      accepted,
      done: e.done,
      cancel: () => this.cancel(e),
      detach: () => {
        if (listener) e.listeners.delete(listener);
      },
      returned: () => {
        if (e.view.delivery !== "returned")
          this.telemetry.record(e.trace, "returned");
        e.view.delivery = "returned";
      },
    };
  }
  command(owner: Owner, raw: unknown) {
    const m = parse(raw);
    if (m.type === "request") throw Error("EXPECTED_CONTROL");
    if (Object.keys(m.payload).length) throw Error("INVALID_CONTROL");
    this.sweep();
    const e = this.get(owner, m.requestId);
    const previous = e.messages.get(m.messageId),
      fingerprint = canonical(m);
    if (previous && previous !== fingerprint) throw Error("MESSAGE_CONFLICT");
    if (!previous) {
      // Keep one emergency control slot: read traffic must never prevent cancellation.
      if (e.messages.size >= 128) {
        if (m.type !== "cancel") throw Error("MESSAGE_LIMIT");
        if (e.view.cancelRequested || terminal(e.view.state))
          return this.view(e);
      }
      e.messages.set(m.messageId, fingerprint);
      if (m.type === "cancel") this.cancel(e);
    }
    return this.view(e);
  }
  private removeQueued(e: Entry) {
    this.queue = this.queue.filter((entry) => entry !== e);
    if (!this.queue.some((entry) => entry.owner === e.owner))
      this.readyOwners = this.readyOwners.filter((owner) => owner !== e.owner);
  }
  /** Trusted host owner required. Never exposes other sessions or business payloads. */
  inspect(owner: Owner) {
    if (!owner || typeof owner.sessionId !== "string" || !owner.sessionId)
      throw Error("OWNING_SESSION_REQUIRED");
    this.sweep();
    const now = performance.now();
    const records = [...this.entries.values()].filter(
      (e) => e.owner === owner.sessionId,
    );
    // Active work must not disappear behind newer terminal history.
    const active = records.filter((e) => !terminal(e.view.state));
    const history = records.filter((e) => terminal(e.view.state)).reverse();
    const selected = [...active, ...history].slice(0, 50);
    const tasks = selected.map((e) => ({
      requestId: e.view.requestId,
      state: e.view.state,
      delivery: e.view.delivery,
      cancelRequested: e.view.cancelRequested,
      error: e.view.error ?? null,
      progress: e.view.progress ?? null,
      waitReason:
        e.view.state === "queued"
          ? this.running >= this.options.concurrency
            ? "concurrency"
            : "dispatch"
          : null,
      phase: terminal(e.view.state)
        ? e.view.delivery === "returned"
          ? "returned"
          : "terminal"
        : e.view.cancelRequested
          ? "cancelling"
          : e.view.state,
      queueMs: Math.max(0, (e.startedAt ?? e.finishedAt ?? now) - e.trace.at),
      runMs:
        e.startedAt === undefined
          ? 0
          : Math.max(0, (e.finishedAt ?? now) - e.startedAt),
      remainingQueueMs:
        e.view.state === "queued" && e.deadline !== undefined
          ? Math.max(0, e.deadline - now)
          : null,
    }));
    return freezeJson({
      phase: this.shutdownPhase,
      policy: { ...this.admission },
      counts: {
        queued: records.filter((e) => e.view.state === "queued").length,
        running: records.filter((e) => e.view.state === "running").length,
        terminal: records.filter((e) => terminal(e.view.state)).length,
      },
      tasks,
      truncated: records.length > 50,
    });
  }
  private cancel(e: Entry) {
    if (terminal(e.view.state) || e.view.cancelRequested) return;
    e.view.cancelRequested = true;
    this.telemetry.record(e.trace, "cancel_requested");
    e.controller.abort();
    this.emit(e, "cancel_requested", {});
    if (e.view.state === "queued") {
      this.removeQueued(e);
      this.finish(e, "cancelled");
    }
  }
  private finish(
    e: Entry,
    state: State,
    result?: unknown,
    error?: string,
    resultBytes = 0,
  ) {
    if (terminal(e.view.state)) return;
    if (e.queueTimer !== undefined) {
      clearTimeout(e.queueTimer);
      e.queueTimer = undefined;
    }
    e.finishedAt = performance.now();
    // Prepare the delivery snapshot BEFORE committing an irreversible terminal state.
    let next: RecordView = { ...e.view, state, sequence: e.view.sequence + 1 };
    if (result !== undefined) next.result = result;
    if (error) next.error = error;
    let snapshot: RecordView;
    try {
      snapshot = freezeJson(structuredClone(next));
    } catch {
      state = "unknown";
      resultBytes = 0;
      next = {
        requestId: e.view.requestId,
        state,
        sequence: e.view.sequence + 1,
        cancelRequested: e.view.cancelRequested,
        delivery: e.view.delivery,
        error: "RESULT_NOT_RETAINED",
      };
      snapshot = freezeJson({ ...next });
    }
    e.resultBytes = resultBytes;
    this.retainedResultBytes += resultBytes;
    e.created = Date.now();
    e.view = { ...next, sequence: next.sequence - 1 };
    this.telemetry.record(e.trace, "terminal");
    e.resolve(snapshot);
    this.emit(e, state, { state });
    // A reentrant terminal notification may still be queued behind this batch.
    if (!e.dispatching) e.listeners.clear();
  }
  private pump() {
    while (
      !this.closed &&
      this.running < this.options.concurrency &&
      this.queue.length
    ) {
      let index = -1;
      while (this.readyOwners.length && index < 0) {
        const owner = this.readyOwners.shift()!;
        index = this.queue.findIndex((entry) => entry.owner === owner);
        if (
          index >= 0 &&
          this.queue.some((entry, i) => i !== index && entry.owner === owner)
        )
          this.readyOwners.push(owner);
      }
      if (index < 0) index = 0;
      const e = this.queue.splice(index, 1)[0];
      if (e.view.state !== "queued") continue;
      if (e.deadline !== undefined && performance.now() >= e.deadline) {
        this.finish(e, "failed", undefined, "QUEUE_WAIT_TIMEOUT");
        continue;
      }
      if (e.queueTimer !== undefined) {
        clearTimeout(e.queueTimer);
        e.queueTimer = undefined;
      }
      e.startedAt = performance.now();
      this.running++;
      e.view.state = "running";
      this.telemetry.record(e.trace, "started");
      this.emit(e, "started", {});
      void this.run(e).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }
  private async run(e: Entry) {
    try {
      const result = await e.handler.run(e.input, {
        invoke: e.invoke,
        signal: e.controller.signal,
        requestId: e.view.requestId,
        progress: (seq, pct) => {
          if (
            e.view.state !== "running" ||
            !Number.isSafeInteger(seq) ||
            seq <= e.sourceSequence ||
            !Number.isFinite(pct) ||
            pct < 0 ||
            pct > 100
          )
            return;
          e.sourceSequence = seq;
          e.view.progress = pct;
          this.emit(e, "progress", { percent: pct });
        },
      });
      let json: string | undefined;
      try {
        assertJson(result);
        json = JSON.stringify(result);
      } catch {
        this.finish(e, "unknown", undefined, "RESULT_NOT_RETAINED");
        return;
      }
      if (
        json === undefined ||
        Buffer.byteLength(json) > this.options.resultBytes
      ) {
        this.finish(e, "unknown", undefined, "RESULT_NOT_RETAINED");
        return;
      }
      this.finish(
        e,
        "succeeded",
        JSON.parse(json),
        undefined,
        Buffer.byteLength(json),
      );
    } catch (err) {
      const cancelled =
        e.controller.signal.aborted &&
        err instanceof Error &&
        err.name === "AbortError";
      this.finish(
        e,
        cancelled
          ? "cancelled"
          : e.controller.signal.aborted
            ? "unknown"
            : "failed",
        undefined,
        cancelled
          ? "CANCELLED"
          : e.controller.signal.aborted
            ? "CANCELLATION_UNCONFIRMED"
            : "HANDLER_FAILED",
      );
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.shutdownPhase = "cancelling";
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((r, j) => {
      resolve = r;
      reject = j;
    });
    void (async () => {
      const entries = [...this.entries.values()];
      for (const e of entries) this.cancel(e);
      this.shutdownPhase = "draining";
      await Promise.all(entries.map((e) => e.done));
      this.handlers.clear();
      this.entries.clear();
      this.retainedResultBytes = 0;
      this.queue = [];
      this.readyOwners = [];
      this.shutdownPhase = "closed";
    })().then(resolve, reject);
    return this.closing;
  }
}
