import { randomUUID, createHash } from "node:crypto";
import { assertJson } from "./json.js";
import { Diagnostics } from "./diagnostics.js";
export function object(v) {
    if (!v || typeof v !== "object" || Array.isArray(v))
        throw Error("INVALID_OBJECT");
    return v;
}
function canonical(v) {
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map(canonical).join(",") + "]";
    return ("{" +
        Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) +
            ":" +
            canonical(v[k]))
            .join(",") +
        "}");
}
export function parse(raw) {
    assertJson(raw);
    const m = object(raw);
    if (Object.keys(m).some((k) => ![
        "protocolVersion",
        "messageId",
        "requestId",
        "type",
        "payload",
    ].includes(k)))
        throw Error("UNKNOWN_FIELD");
    if (m.protocolVersion !== 1)
        throw Error("UNSUPPORTED_VERSION");
    for (const k of ["messageId", "requestId"])
        if (typeof m[k] !== "string" ||
            !/^[a-zA-Z0-9_.:-]{1,128}$/.test(m[k]))
            throw Error("INVALID_ID");
    if (!["request", "status", "result", "cancel"].includes(m.type))
        throw Error("UNSUPPORTED_TYPE");
    object(m.payload);
    if (Buffer.byteLength(JSON.stringify(m)) > 16384)
        throw Error("MESSAGE_TOO_LARGE");
    return structuredClone(m);
}
function freezeJson(value) {
    if (value && typeof value === "object") {
        for (const child of Object.values(value))
            freezeJson(child);
        Object.freeze(value);
    }
    return value;
}
const terminal = (s) => !["queued", "running"].includes(s);
/** Volatile single-process bus; no acceptance durability or automatic execution retry. */
export class ExecutionBus {
    options;
    entries = new Map();
    handlers = new Map();
    queue = [];
    readyOwners = [];
    running = 0;
    retainedResultBytes = 0;
    closed = false;
    telemetry = new Diagnostics();
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
    closing;
    shutdownPhase = "open";
    constructor(options = {
        concurrency: 2,
        queueLimit: 32,
        recordLimit: 256,
        resultBytes: 65536,
        retentionMs: 3600000,
    }) {
        this.options = options;
        const keys = [
            "concurrency",
            "queueLimit",
            "recordLimit",
            "resultBytes",
            "retentionMs",
        ];
        if (!options ||
            typeof options !== "object" ||
            Array.isArray(options) ||
            Reflect.ownKeys(options).length !== keys.length ||
            keys.some((key) => {
                const descriptor = Object.getOwnPropertyDescriptor(options, key);
                return (!descriptor || !("value" in descriptor) || !descriptor.enumerable);
            }))
            throw Error("INVALID_OPTIONS");
        this.options = Object.freeze({ ...options });
        for (const v of Object.values(this.options))
            if (!Number.isSafeInteger(v) || v < 1)
                throw Error("INVALID_OPTIONS");
    }
    register(name, handler) {
        if (this.handlers.has(name))
            throw Error("DUPLICATE_HANDLER");
        const registration = { handler, token: Symbol(name) };
        this.handlers.set(name, registration);
        let disposed = false;
        return () => {
            if (disposed)
                return;
            disposed = true;
            if (this.handlers.get(name)?.token === registration.token)
                this.handlers.delete(name);
        };
    }
    key(o, id) {
        if (!o.sessionId || !o.callId)
            throw Error("UNTRUSTED_CONTEXT");
        return JSON.stringify([o.sessionId, id]);
    }
    emit(e, type, payload, correlationId = "") {
        e.view.sequence++;
        const event = freezeJson({
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
        if (e.dispatching)
            return;
        e.dispatching = true;
        try {
            while (e.notifications.length) {
                const batch = e.notifications.shift();
                for (const listener of batch.listeners) {
                    if (!e.listeners.has(listener))
                        continue;
                    try {
                        void Promise.resolve(listener(batch.event)).catch(() => { });
                    }
                    catch { }
                }
            }
        }
        finally {
            e.dispatching = false;
            if (terminal(e.view.state))
                e.listeners.clear();
        }
    }
    view(e) {
        return structuredClone(e.view);
    }
    get(o, id) {
        const e = this.entries.get(this.key(o, id));
        if (!e)
            throw Error("NOT_FOUND");
        return e;
    }
    sweep(now = Date.now()) {
        for (const [k, e] of this.entries)
            if (terminal(e.view.state) &&
                now - e.created > this.options.retentionMs) {
                this.retainedResultBytes -= e.resultBytes;
                this.entries.delete(k);
            }
    }
    submit(owner, raw, onEvent, invoke) {
        if (this.closed)
            throw Error("CLOSED");
        const m = parse(raw);
        if (m.type !== "request")
            throw Error("EXPECTED_REQUEST");
        const p = m.payload;
        if (Object.keys(p).some((k) => !["handler", "input"].includes(k)) ||
            typeof p.handler !== "string")
            throw Error("INVALID_REQUEST");
        const input = object(p.input);
        const key = this.key(owner, m.requestId), fp = createHash("sha256").update(canonical(p)).digest("hex");
        this.sweep();
        let e = this.entries.get(key);
        if (e) {
            if (e.fingerprint !== fp)
                throw Error("REQUEST_CONFLICT");
            const previous = e.messages.get(m.messageId);
            if (previous && previous !== canonical(m))
                throw Error("MESSAGE_CONFLICT");
            if (!previous && e.messages.size >= 128)
                throw Error("MESSAGE_LIMIT");
            // Acquire the attachment before committing its message identity. Rejection is side-effect free.
            const attached = this.attachment(e, onEvent, m.messageId);
            if (!previous)
                e.messages.set(m.messageId, canonical(m));
            this.telemetry.record(e.trace, "reused");
            return attached;
        }
        const handler = this.handlers.get(p.handler)?.handler;
        if (!handler)
            throw Error("UNKNOWN_HANDLER");
        handler.validate(input);
        if (this.entries.size >= this.options.recordLimit ||
            this.queue.length >= this.options.queueLimit)
            throw Error("BACKPRESSURE");
        let resolve;
        const done = new Promise((r) => (resolve = r));
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
        if (!this.readyOwners.includes(e.owner))
            this.readyOwners.push(e.owner);
        queueMicrotask(() => this.pump());
        return attached;
    }
    attachment(e, onEvent, id) {
        // Each attachment owns its registration, even when callers reuse one function.
        const listener = onEvent ? (event) => onEvent(event) : undefined;
        if (listener && !terminal(e.view.state)) {
            if (e.listeners.size >= 32)
                throw Error("WAITER_LIMIT");
            e.listeners.add(listener);
        }
        const accepted = {
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
                if (listener)
                    e.listeners.delete(listener);
            },
            returned: () => {
                if (e.view.delivery !== "returned")
                    this.telemetry.record(e.trace, "returned");
                e.view.delivery = "returned";
            },
        };
    }
    command(owner, raw) {
        const m = parse(raw);
        if (m.type === "request")
            throw Error("EXPECTED_CONTROL");
        if (Object.keys(m.payload).length)
            throw Error("INVALID_CONTROL");
        this.sweep();
        const e = this.get(owner, m.requestId);
        const previous = e.messages.get(m.messageId), fingerprint = canonical(m);
        if (previous && previous !== fingerprint)
            throw Error("MESSAGE_CONFLICT");
        if (!previous) {
            // Keep one emergency control slot: read traffic must never prevent cancellation.
            if (e.messages.size >= 128) {
                if (m.type !== "cancel")
                    throw Error("MESSAGE_LIMIT");
                if (e.view.cancelRequested || terminal(e.view.state))
                    return this.view(e);
            }
            e.messages.set(m.messageId, fingerprint);
            if (m.type === "cancel")
                this.cancel(e);
        }
        return this.view(e);
    }
    cancel(e) {
        if (terminal(e.view.state) || e.view.cancelRequested)
            return;
        e.view.cancelRequested = true;
        this.telemetry.record(e.trace, "cancel_requested");
        e.controller.abort();
        this.emit(e, "cancel_requested", {});
        if (e.view.state === "queued") {
            this.queue = this.queue.filter((x) => x !== e);
            if (!this.queue.some((entry) => entry.owner === e.owner))
                this.readyOwners = this.readyOwners.filter((owner) => owner !== e.owner);
            this.finish(e, "cancelled");
        }
    }
    finish(e, state, result, error, resultBytes = 0) {
        if (terminal(e.view.state))
            return;
        // Prepare the delivery snapshot BEFORE committing an irreversible terminal state.
        let next = { ...e.view, state, sequence: e.view.sequence + 1 };
        if (result !== undefined)
            next.result = result;
        if (error)
            next.error = error;
        let snapshot;
        try {
            snapshot = freezeJson(structuredClone(next));
        }
        catch {
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
        if (!e.dispatching)
            e.listeners.clear();
    }
    pump() {
        while (!this.closed &&
            this.running < this.options.concurrency &&
            this.queue.length) {
            let index = -1;
            while (this.readyOwners.length && index < 0) {
                const owner = this.readyOwners.shift();
                index = this.queue.findIndex((entry) => entry.owner === owner);
                if (index >= 0 &&
                    this.queue.some((entry, i) => i !== index && entry.owner === owner))
                    this.readyOwners.push(owner);
            }
            if (index < 0)
                index = 0;
            const e = this.queue.splice(index, 1)[0];
            if (e.view.state !== "queued")
                continue;
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
    async run(e) {
        try {
            const result = await e.handler.run(e.input, {
                invoke: e.invoke,
                signal: e.controller.signal,
                requestId: e.view.requestId,
                progress: (seq, pct) => {
                    if (e.view.state !== "running" ||
                        !Number.isSafeInteger(seq) ||
                        seq <= e.sourceSequence ||
                        !Number.isFinite(pct) ||
                        pct < 0 ||
                        pct > 100)
                        return;
                    e.sourceSequence = seq;
                    e.view.progress = pct;
                    this.emit(e, "progress", { percent: pct });
                },
            });
            let json;
            try {
                assertJson(result);
                json = JSON.stringify(result);
            }
            catch {
                this.finish(e, "unknown", undefined, "RESULT_NOT_RETAINED");
                return;
            }
            if (json === undefined ||
                Buffer.byteLength(json) > this.options.resultBytes) {
                this.finish(e, "unknown", undefined, "RESULT_NOT_RETAINED");
                return;
            }
            this.finish(e, "succeeded", JSON.parse(json), undefined, Buffer.byteLength(json));
        }
        catch (err) {
            const cancelled = e.controller.signal.aborted &&
                err instanceof Error &&
                err.name === "AbortError";
            this.finish(e, cancelled
                ? "cancelled"
                : e.controller.signal.aborted
                    ? "unknown"
                    : "failed", undefined, cancelled
                ? "CANCELLED"
                : e.controller.signal.aborted
                    ? "CANCELLATION_UNCONFIRMED"
                    : "HANDLER_FAILED");
        }
    }
    close() {
        if (this.closing)
            return this.closing;
        this.closed = true;
        this.shutdownPhase = "cancelling";
        let resolve, reject;
        this.closing = new Promise((r, j) => {
            resolve = r;
            reject = j;
        });
        void (async () => {
            const entries = [...this.entries.values()];
            for (const e of entries)
                this.cancel(e);
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
