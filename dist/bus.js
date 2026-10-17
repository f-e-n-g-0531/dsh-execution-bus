import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Diagnostics } from "./diagnostics.js";
import { ERRORS } from "./error-codes.js";
import { assertJson } from "./json.js";
import { LIMITS } from "./limits.js";
import { CORE_DEFAULTS } from "./product.js";
import { canonical, freezeJson, object, parse } from "./protocol.js";
export { object, parse };
const isTerminal = (s) => !["queued", "running"].includes(s);
/** 对 payload 做规范排序后的 SHA-256 摘要，仅用于同 requestId 的冲突比较。 */
function hashPayload(payload) {
    return createHash("sha256").update(canonical(payload)).digest("hex");
}
/** Volatile single-process bus; no acceptance durability or automatic execution retry. */
export class ExecutionBus {
    options;
    admission;
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
    constructor(options = CORE_DEFAULTS, admission = {}) {
        this.options = options;
        this.admission = admission;
        const allowed = ["sessionQueueLimit", "maxQueueWaitMs"];
        if (!admission ||
            typeof admission !== "object" ||
            Array.isArray(admission) ||
            Reflect.ownKeys(admission).some((key) => typeof key !== "string" || !allowed.includes(key)))
            throw Error(ERRORS.INVALID_ADMISSION_POLICY);
        for (const key of Reflect.ownKeys(admission)) {
            const descriptor = Object.getOwnPropertyDescriptor(admission, key);
            if (!("value" in descriptor) ||
                !descriptor.enumerable ||
                !Number.isSafeInteger(descriptor.value) ||
                descriptor.value < 1 ||
                descriptor.value > 2147483647)
                throw Error(ERRORS.INVALID_ADMISSION_POLICY);
        }
        this.admission = Object.freeze({ ...admission });
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
            throw Error(ERRORS.INVALID_OPTIONS);
        this.options = Object.freeze({ ...options });
        for (const v of Object.values(this.options))
            if (!Number.isSafeInteger(v) || v < 1)
                throw Error(ERRORS.INVALID_OPTIONS);
    }
    register(name, handler) {
        if (this.handlers.has(name))
            throw Error(ERRORS.DUPLICATE_HANDLER);
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
            throw Error(ERRORS.UNTRUSTED_CONTEXT);
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
        // 在调用用户代码前快照并排队：嵌套取消无法抢到当前事件。
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
            if (isTerminal(e.view.state))
                e.listeners.clear();
        }
    }
    view(e) {
        return structuredClone(e.view);
    }
    get(o, id) {
        const e = this.entries.get(this.key(o, id));
        if (!e)
            throw Error(ERRORS.NOT_FOUND);
        return e;
    }
    sweep(now = Date.now()) {
        for (const [k, e] of this.entries)
            if (isTerminal(e.view.state) && now - e.created > this.options.retentionMs) {
                this.retainedResultBytes -= e.resultBytes;
                this.entries.delete(k);
            }
    }
    submit(owner, raw, onEvent, invoke) {
        if (this.closed)
            throw Error(ERRORS.CLOSED);
        const m = parse(raw);
        if (m.type !== "request")
            throw Error(ERRORS.EXPECTED_REQUEST);
        const parts = this.requestParts(m);
        const key = this.key(owner, m.requestId);
        const fingerprint = hashPayload(parts.payload);
        this.sweep();
        const existing = this.entries.get(key);
        return existing
            ? this.reuseInvocation(existing, m, fingerprint, onEvent)
            : this.admitInvocation(owner, m, parts, key, fingerprint, invoke, onEvent);
    }
    /** 校验并拆解 request 的 payload，返回 handler 名、入参与原文。 */
    requestParts(m) {
        const p = m.payload;
        if (Object.keys(p).some((k) => !["handler", "input"].includes(k)) ||
            typeof p.handler !== "string")
            throw Error(ERRORS.INVALID_REQUEST);
        return {
            handler: p.handler,
            input: object(p.input),
            payload: p,
        };
    }
    /** 同一 requestId 的重复提交：校验一致性后复用执行或结果。 */
    reuseInvocation(e, m, fingerprint, onEvent) {
        if (e.fingerprint !== fingerprint)
            throw Error(ERRORS.REQUEST_CONFLICT);
        const previous = e.messages.get(m.messageId);
        if (previous && previous !== canonical(m))
            throw Error(ERRORS.MESSAGE_CONFLICT);
        if (!previous && e.messages.size >= LIMITS.messageAccountLimit)
            throw Error(ERRORS.MESSAGE_LIMIT);
        // 先取得附着，再提交消息身份：附着被拒（WAITER_LIMIT）时无副作用。
        const attached = this.attachment(e, onEvent, m.messageId);
        if (!previous)
            e.messages.set(m.messageId, canonical(m));
        this.telemetry.record(e.trace, "reused");
        return attached;
    }
    /** 受理全新请求：校验 Handler、检查容量、构建记录并入队。 */
    admitInvocation(owner, m, parts, key, fingerprint, invoke, onEvent) {
        const handler = this.handlers.get(parts.handler)?.handler;
        if (!handler)
            throw Error(ERRORS.UNKNOWN_HANDLER);
        handler.validate(parts.input);
        if (this.entries.size >= this.options.recordLimit ||
            this.queue.length >= this.options.queueLimit)
            throw Error(ERRORS.BACKPRESSURE);
        if (this.admission.sessionQueueLimit !== undefined &&
            this.queue.filter((entry) => entry.owner === owner.sessionId).length >=
                this.admission.sessionQueueLimit)
            throw Error(ERRORS.SESSION_BACKPRESSURE);
        let resolve;
        const done = new Promise((r) => (resolve = r));
        const e = {
            trace: this.telemetry.begin(),
            resultBytes: 0,
            invoke,
            correlationId: m.messageId,
            owner: owner.sessionId,
            fingerprint,
            handler,
            input: structuredClone(parts.input),
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
        this.scheduleQueueDeadline(e);
        if (!this.readyOwners.includes(e.owner))
            this.readyOwners.push(e.owner);
        queueMicrotask(() => this.pump());
        return attached;
    }
    /** 若启用了排队期限，登记到期结算为 QUEUE_WAIT_TIMEOUT 的计时器。 */
    scheduleQueueDeadline(e) {
        if (this.admission.maxQueueWaitMs === undefined)
            return;
        e.deadline = performance.now() + this.admission.maxQueueWaitMs;
        const expire = () => {
            if (e.view.state !== "queued")
                return;
            const remaining = e.deadline - performance.now();
            if (remaining > 0) {
                e.queueTimer = setTimeout(expire, Math.ceil(remaining));
                return;
            }
            this.removeQueued(e);
            this.finish(e, "failed", undefined, "QUEUE_WAIT_TIMEOUT");
        };
        e.queueTimer = setTimeout(expire, this.admission.maxQueueWaitMs);
    }
    attachment(e, onEvent, id) {
        // 每次附着独立占配额，即使调用方复用同一个回调。
        const listener = onEvent ? (event) => onEvent(event) : undefined;
        if (listener && !isTerminal(e.view.state)) {
            if (e.listeners.size >= LIMITS.waiterLimit)
                throw Error(ERRORS.WAITER_LIMIT);
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
            throw Error(ERRORS.EXPECTED_CONTROL);
        if (Object.keys(m.payload).length)
            throw Error(ERRORS.INVALID_CONTROL);
        this.sweep();
        const e = this.get(owner, m.requestId);
        const previous = e.messages.get(m.messageId), fingerprint = canonical(m);
        if (previous && previous !== fingerprint)
            throw Error(ERRORS.MESSAGE_CONFLICT);
        if (!previous) {
            // 保留一个应急控制槽：读流量绝不能阻塞取消。
            if (e.messages.size >= LIMITS.messageAccountLimit) {
                if (m.type !== "cancel")
                    throw Error(ERRORS.MESSAGE_LIMIT);
                if (e.view.cancelRequested || isTerminal(e.view.state))
                    return this.view(e);
            }
            e.messages.set(m.messageId, fingerprint);
            if (m.type === "cancel")
                this.cancel(e);
        }
        return this.view(e);
    }
    removeQueued(e) {
        this.queue = this.queue.filter((entry) => entry !== e);
        if (!this.queue.some((entry) => entry.owner === e.owner))
            this.readyOwners = this.readyOwners.filter((owner) => owner !== e.owner);
    }
    /** Trusted host owner required. Never exposes other sessions or business payloads. */
    inspect(owner) {
        if (!owner || typeof owner.sessionId !== "string" || !owner.sessionId)
            throw Error(ERRORS.OWNING_SESSION_REQUIRED);
        this.sweep();
        const now = performance.now();
        const records = [...this.entries.values()].filter((e) => e.owner === owner.sessionId);
        // 活跃任务不得被更新的终态历史挤到列表之外。
        const active = records.filter((e) => !isTerminal(e.view.state));
        const history = records.filter((e) => isTerminal(e.view.state)).reverse();
        const selected = [...active, ...history].slice(0, LIMITS.inspectTaskLimit);
        const tasks = selected.map((e) => ({
            requestId: e.view.requestId,
            state: e.view.state,
            delivery: e.view.delivery,
            cancelRequested: e.view.cancelRequested,
            error: e.view.error ?? null,
            progress: e.view.progress ?? null,
            waitReason: e.view.state === "queued"
                ? this.running >= this.options.concurrency
                    ? "concurrency"
                    : "dispatch"
                : null,
            phase: isTerminal(e.view.state)
                ? e.view.delivery === "returned"
                    ? "returned"
                    : "terminal"
                : e.view.cancelRequested
                    ? "cancelling"
                    : e.view.state,
            queueMs: Math.max(0, (e.startedAt ?? e.finishedAt ?? now) - e.trace.at),
            runMs: e.startedAt === undefined
                ? 0
                : Math.max(0, (e.finishedAt ?? now) - e.startedAt),
            remainingQueueMs: e.view.state === "queued" && e.deadline !== undefined
                ? Math.max(0, e.deadline - now)
                : null,
        }));
        return freezeJson({
            phase: this.shutdownPhase,
            policy: { ...this.admission },
            counts: {
                queued: records.filter((e) => e.view.state === "queued").length,
                running: records.filter((e) => e.view.state === "running").length,
                terminal: records.filter((e) => isTerminal(e.view.state)).length,
            },
            tasks,
            truncated: records.length > LIMITS.inspectTaskLimit,
        });
    }
    cancel(e) {
        if (isTerminal(e.view.state) || e.view.cancelRequested)
            return;
        e.view.cancelRequested = true;
        this.telemetry.record(e.trace, "cancel_requested");
        e.controller.abort();
        this.emit(e, "cancel_requested", {});
        if (e.view.state === "queued") {
            this.removeQueued(e);
            this.finish(e, "cancelled");
        }
    }
    finish(e, state, result, error, resultBytes = 0) {
        if (isTerminal(e.view.state))
            return;
        if (e.queueTimer !== undefined) {
            clearTimeout(e.queueTimer);
            e.queueTimer = undefined;
        }
        e.finishedAt = performance.now();
        // 终态事件是下一个序号；先用它构建快照，避免把不可逆终态提交到视图之外。
        const terminalSequence = e.view.sequence + 1;
        let next = { ...e.view, state, sequence: terminalSequence };
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
                sequence: terminalSequence,
                cancelRequested: e.view.cancelRequested,
                delivery: e.view.delivery,
                error: "RESULT_NOT_RETAINED",
            };
            snapshot = freezeJson({ ...next });
        }
        e.resultBytes = resultBytes;
        this.retainedResultBytes += resultBytes;
        e.created = Date.now();
        // emit() 会再自增序号；先整体回退一档，使终态事件恰好落在 terminalSequence，
        // 与上面交付给等待者的快照序号完全一致。
        e.view = { ...next, sequence: terminalSequence - 1 };
        this.telemetry.record(e.trace, "terminal");
        e.resolve(snapshot);
        this.emit(e, state, { state });
        // 重入的终态通知可能仍排在本批之后。
        if (!e.dispatching)
            e.listeners.clear();
    }
    /** 按会话轮转挑选下一个出队项：各会话内部 FIFO，跨会话公平。 */
    nextQueuedIndex() {
        let index = -1;
        while (this.readyOwners.length && index < 0) {
            const owner = this.readyOwners.shift();
            const i = this.queue.findIndex((entry) => entry.owner === owner);
            if (i >= 0) {
                index = i;
                // 找到后，若该会话仍有其它排队任务，保留其轮次避免单个会话饥饿。
                if (this.queue.some((entry, j) => j !== i && entry.owner === owner))
                    this.readyOwners.push(owner);
            }
        }
        return index < 0 ? 0 : index;
    }
    pump() {
        while (!this.closed &&
            this.running < this.options.concurrency &&
            this.queue.length) {
            const index = this.nextQueuedIndex();
            const e = this.queue.splice(index, 1)[0];
            if (e.view.state !== "queued")
                continue;
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
