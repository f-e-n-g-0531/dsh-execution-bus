import { randomUUID, createHash } from "node:crypto";
import { assertJson } from "./json.js";
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
  private running = 0;
  private closed = false;
  constructor(
    readonly options = {
      concurrency: 2,
      queueLimit: 32,
      recordLimit: 256,
      resultBytes: 65536,
      retentionMs: 3600000,
    },
  ) {
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
    for (const f of e.listeners)
      try {
        // Observe promise rejection without awaiting or blocking task settlement.
        void Promise.resolve(f(event)).catch(() => {
          /* Async observers are best-effort; never leak their error text. */
        });
      } catch {
        /* Observers cannot alter execution. */
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
      if (terminal(e.view.state) && now - e.created > this.options.retentionMs)
        this.entries.delete(k);
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
    let resolve!: (v: RecordView) => void;
    const done = new Promise<RecordView>((r) => (resolve = r));
    e = {
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
      sourceSequence: 0,
      created: Date.now(),
      messages: new Map([[m.messageId, canonical(m)]]),
    };
    this.entries.set(key, e);
    const attached = this.attachment(e, onEvent, m.messageId);
    this.queue.push(e);
    queueMicrotask(() => this.pump());
    return attached;
  }
  private attachment(
    e: Entry,
    onEvent: ((e: Event) => void) | undefined,
    id: string,
  ) {
    if (onEvent && !terminal(e.view.state)) {
      if (e.listeners.size >= 32) throw Error("WAITER_LIMIT");
      e.listeners.add(onEvent);
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
        if (onEvent) e.listeners.delete(onEvent);
      },
      returned: () => {
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
  private cancel(e: Entry) {
    if (terminal(e.view.state) || e.view.cancelRequested) return;
    e.view.cancelRequested = true;
    e.controller.abort();
    this.emit(e, "cancel_requested", {});
    if (e.view.state === "queued") {
      this.queue = this.queue.filter((x) => x !== e);
      this.finish(e, "cancelled");
    }
  }
  private finish(e: Entry, state: State, result?: unknown, error?: string) {
    if (terminal(e.view.state)) return;
    // Prepare the delivery snapshot BEFORE committing an irreversible terminal state.
    let next: RecordView = { ...e.view, state, sequence: e.view.sequence + 1 };
    if (result !== undefined) next.result = result;
    if (error) next.error = error;
    let snapshot: RecordView;
    try {
      snapshot = freezeJson(structuredClone(next));
    } catch {
      state = "unknown";
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
    e.created = Date.now();
    e.view = { ...next, sequence: next.sequence - 1 };
    this.emit(e, state, { state });
    e.resolve(snapshot);
    e.listeners.clear();
  }
  private pump() {
    while (
      !this.closed &&
      this.running < this.options.concurrency &&
      this.queue.length
    ) {
      const e = this.queue.shift()!;
      if (e.view.state !== "queued") continue;
      this.running++;
      e.view.state = "running";
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
      this.finish(e, "succeeded", JSON.parse(json));
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
  async close() {
    this.closed = true;
    for (const e of this.entries.values()) this.cancel(e);
    await Promise.all([...this.entries.values()].map((e) => e.done));
    this.handlers.clear();
    this.entries.clear();
  }
}
