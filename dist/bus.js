import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Diagnostics } from "./diagnostics.js";
import { ERRORS } from "./error-codes.js";
import { assertJson } from "./json.js";
import { LIMITS } from "./limits.js";
import { CORE_DEFAULTS, SCHEDULER_POLICY } from "./product.js";
import { canonical, freezeJson, object, parse } from "./protocol.js";
export { object, parse };
const isTerminal = (s) => !["queued", "running"].includes(s);
/** 对 payload 做规范排序后的 SHA-256 摘要，仅用于同 requestId 的冲突比较。 */
function hashPayload(payload) {
    return createHash("sha256").update(canonical(payload)).digest("hex");
}
/** 消息身份只保存摘要，避免为每个 messageId 保留完整消息文本占用内存。 */
function hashMessage(m) {
    return createHash("sha256").update(canonical(m)).digest("hex");
}
/** Volatile single-process bus; no acceptance durability or automatic execution retry. */
export class ExecutionBus {
    options;
    admission;
    scheduler;
    entries = new Map();
    handlers = new Map();
    queue = [];
    readyOwners = [];
    running = 0;
    runningByHandler = new Map();
    /** 资源键 → 占用它的运行中 Entry；有副作用 Handler 据此互斥。 */
    resourceLocks = new Map();
    /** payload 指纹 → 已成功或运行中的 Entry，用于唯一任务复用。 */
    dedupeIndex = new Map();
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
    constructor(options = CORE_DEFAULTS, admission = {}, scheduler = SCHEDULER_POLICY) {
        this.options = options;
        this.admission = admission;
        this.scheduler = scheduler;
        const schedulerKeys = ["queueClassOrder", "queueAgingMs", "longRunningMs"];
        if (!scheduler ||
            typeof scheduler !== "object" ||
            Array.isArray(scheduler) ||
            Reflect.ownKeys(scheduler).some((key) => typeof key !== "string" || !schedulerKeys.includes(key)))
            throw Error(ERRORS.INVALID_OPTIONS);
        for (const key of Reflect.ownKeys(scheduler)) {
            const descriptor = Object.getOwnPropertyDescriptor(scheduler, key);
            if (!("value" in descriptor) || !descriptor.enumerable)
                throw Error(ERRORS.INVALID_OPTIONS);
        }
        // 只读取一次：拒绝 accessor，避免校验值与落库值不一致。
        const queueAgingMs = scheduler.queueAgingMs;
        const longRunningMs = scheduler.longRunningMs;
        const rawOrder = scheduler.queueClassOrder;
        if (!Number.isSafeInteger(queueAgingMs) ||
            queueAgingMs < 1 ||
            !Number.isSafeInteger(longRunningMs) ||
            longRunningMs < 1 ||
            !rawOrder ||
            typeof rawOrder !== "object" ||
            Array.isArray(rawOrder))
            throw Error(ERRORS.INVALID_OPTIONS);
        const order = Object.create(null);
        for (const className of Reflect.ownKeys(rawOrder)) {
            if (typeof className !== "string")
                throw Error(ERRORS.INVALID_OPTIONS);
            if (["__proto__", "constructor", "prototype"].includes(className))
                throw Error(ERRORS.INVALID_OPTIONS);
            const descriptor = Object.getOwnPropertyDescriptor(rawOrder, className);
            if (!("value" in descriptor) || !descriptor.enumerable)
                throw Error(ERRORS.INVALID_OPTIONS);
            const rank = descriptor.value;
            if (className.length === 0 ||
                className.length > 64 ||
                !Number.isSafeInteger(rank) ||
                rank < 0)
                throw Error(ERRORS.INVALID_OPTIONS);
            order[className] = rank;
        }
        this.scheduler = Object.freeze({
            queueClassOrder: Object.freeze(order),
            queueAgingMs: queueAgingMs,
            longRunningMs: longRunningMs,
        });
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
        if (!handler ||
            typeof handler !== "object" ||
            typeof handler.validate !== "function" ||
            typeof handler.run !== "function" ||
            (handler.idempotent !== undefined && typeof handler.idempotent !== "boolean") ||
            (handler.queue !== undefined &&
                (typeof handler.queue !== "string" ||
                    handler.queue.length === 0 ||
                    handler.queue.length > 64 ||
                    ["__proto__", "constructor", "prototype"].includes(handler.queue))) ||
            (handler.maxConcurrency !== undefined &&
                (!Number.isSafeInteger(handler.maxConcurrency) ||
                    handler.maxConcurrency < 1)) ||
            (handler.dedupe !== undefined && handler.dedupe !== "payload") ||
            (handler.dedupe === "payload" && handler.idempotent !== true) ||
            (handler.resources !== undefined && typeof handler.resources !== "function"))
            throw Error(ERRORS.INVALID_HANDLER_OPTIONS);
        // 注册时快照并冻结调度/复用选项，运行期修改原对象不再影响已注册行为。
        const fixed = Object.freeze({
            idempotent: handler.idempotent,
            queue: handler.queue,
            maxConcurrency: handler.maxConcurrency,
            dedupe: handler.dedupe,
            resources: handler.resources?.bind(handler),
            validate: handler.validate.bind(handler),
            run: handler.run.bind(handler),
        });
        const registration = { handler: fixed, token: Symbol(name) };
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
        const live = new Set(this.entries.values());
        for (const [key, e] of this.dedupeIndex)
            if (!live.has(e))
                this.dedupeIndex.delete(key);
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
        // 仅显式声明非幂等（idempotent:false）的 handler，终态结果才不可复用：
        // 返回"已执行"会掩盖副作用状态。运行中的重复 attach 仍放行，不会二次执行。
        if (e.handler.idempotent === false && isTerminal(e.view.state))
            throw Error(ERRORS.MUTATING_REUSE_DENIED);
        const previous = e.messages.get(m.messageId);
        if (previous && previous !== hashMessage(m))
            throw Error(ERRORS.MESSAGE_CONFLICT);
        if (!previous && e.messages.size >= LIMITS.messageAccountLimit)
            throw Error(ERRORS.MESSAGE_LIMIT);
        // 先取得附着，再提交消息身份：附着被拒（WAITER_LIMIT）时无副作用。
        const attached = this.attachment(e, onEvent, m.messageId, true);
        if (!previous)
            e.messages.set(m.messageId, hashMessage(m));
        this.telemetry.record(e.trace, "reused");
        return attached;
    }
    /** 受理全新请求：校验 Handler、检查容量、构建记录并入队。 */
    admitInvocation(owner, m, parts, key, fingerprint, invoke, onEvent) {
        const handler = this.handlers.get(parts.handler)?.handler;
        if (!handler)
            throw Error(ERRORS.UNKNOWN_HANDLER);
        handler.validate(parts.input);
        // validate 是用户代码：可能在同步执行中触发 close()。
        if (this.closed)
            throw Error(ERRORS.CLOSED);
        const dedupeKey = handler.dedupe === "payload"
            ? JSON.stringify([owner.sessionId, parts.handler, fingerprint])
            : undefined;
        if (dedupeKey !== undefined) {
            const target = this.dedupeIndex.get(dedupeKey);
            if (target !== undefined &&
                target.view.state === "succeeded" &&
                isTerminal(target.view.state)) {
                try {
                    const unique = this.syntheticUnique(owner, m, parts, key, fingerprint, handler, target, dedupeKey);
                    return this.attachment(unique, onEvent, m.messageId, true);
                }
                catch (error) {
                    if (error instanceof Error && error.message === ERRORS.BACKPRESSURE)
                        throw error;
                    // 结果不可克隆时退回正常执行，避免把唯一缓存错误变成请求失败。
                }
            }
        }
        const resources = this.resourcesFor(handler, parts.input);
        // resources 也是用户代码，返回后重新确认总线未在同步段关闭。
        if (this.closed)
            throw Error(ERRORS.CLOSED);
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
            handlerName: parts.handler,
            queueClass: handler.queue ?? "default",
            resources,
            dedupeKey,
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
            messages: new Map([[m.messageId, hashMessage(m)]]),
        };
        this.entries.set(key, e);
        if (dedupeKey !== undefined)
            this.dedupeIndex.set(dedupeKey, e);
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
    /** 计算并校验 Handler 的资源键；失败则请求不进入队列。 */
    resourcesFor(handler, input) {
        if (handler.resources === undefined)
            return [];
        let raw;
        try {
            raw = handler.resources(input);
        }
        catch {
            throw Error(ERRORS.INVALID_RESOURCES);
        }
        if (!Array.isArray(raw) || raw.length > 8)
            throw Error(ERRORS.INVALID_RESOURCES);
        const resources = [];
        for (const resource of raw) {
            if (typeof resource !== "string" ||
                resource.length === 0 ||
                resource.length > 256)
                throw Error(ERRORS.INVALID_RESOURCES);
            if (!resources.includes(resource))
                resources.push(resource);
        }
        resources.sort();
        return resources;
    }
    /** 唯一任务命中已成功终态时，构造一个不再执行 Handler 的只读结果记录。 */
    syntheticUnique(owner, m, parts, key, fingerprint, handler, target, dedupeKey) {
        if (this.entries.size >= this.options.recordLimit)
            throw Error(ERRORS.BACKPRESSURE);
        const snapshot = freezeJson(structuredClone({
            requestId: m.requestId,
            state: "succeeded",
            sequence: 1,
            cancelRequested: false,
            delivery: "pending",
            result: target.view.result,
        }));
        let resultBytes = 0;
        try {
            if (snapshot.result !== undefined)
                resultBytes = Buffer.byteLength(JSON.stringify(snapshot.result));
        }
        catch {
            resultBytes = target.resultBytes;
        }
        let resolve;
        const done = new Promise((r) => (resolve = r));
        const trace = this.telemetry.begin();
        const e = {
            trace,
            resultBytes,
            startedAt: trace.at,
            finishedAt: trace.at,
            invoke: undefined,
            correlationId: m.messageId,
            owner: owner.sessionId,
            fingerprint,
            handler,
            handlerName: parts.handler,
            queueClass: handler.queue ?? "default",
            resources: [],
            dedupeKey,
            input: structuredClone(parts.input),
            view: { ...snapshot, sequence: 1 },
            controller: new AbortController(),
            done,
            resolve,
            listeners: new Set(),
            notifications: [],
            dispatching: false,
            sourceSequence: 0,
            created: Date.now(),
            messages: new Map([[m.messageId, hashMessage(m)]]),
        };
        this.entries.set(key, e);
        this.retainedResultBytes += resultBytes;
        this.telemetry.record(e.trace, "accepted");
        this.telemetry.record(e.trace, "unique_reused");
        e.resolve(snapshot);
        return e;
    }
    releaseResources(e) {
        for (const resource of e.resources)
            if (this.resourceLocks.get(resource) === e)
                this.resourceLocks.delete(resource);
    }
    /** 优先类别表按自有属性查；未知类别回退 default 权重，避免原型链 NaN。 */
    classRank(queueClass) {
        const order = this.scheduler.queueClassOrder;
        return Object.hasOwn(order, queueClass) ? order[queueClass] : 3;
    }
    /** 当前阻塞来源：Handler 舱壁优先于资源锁；undefined 表示可运行。 */
    blockedBy(e) {
        const limit = e.handler.maxConcurrency;
        if (limit !== undefined &&
            (this.runningByHandler.get(e.handler) ?? 0) >= limit)
            return "bulkhead";
        for (const resource of e.resources)
            if (this.resourceLocks.has(resource))
                return "resource";
        return undefined;
    }
    /** 是否有空闲槽位供此 Entry 开始执行（Handler 舱壁 + 资源互斥）。 */
    eligible(e) {
        return this.blockedBy(e) === undefined;
    }
    /** 类别优先级 + 等待老化：等待越久提升越多（不封顶），最低到 0；
     *  同分时按队列先后（FIFO）决出，避免低优先类别饥饿。 */
    effectivePriority(e, now) {
        const boost = Math.floor(Math.max(0, now - e.trace.at) / this.scheduler.queueAgingMs);
        return Math.max(0, this.classRank(e.queueClass) - boost);
    }
    /** 对已到期的排队任务结算 QUEUE_WAIT_TIMEOUT，再从队列移除。 */
    expireQueued(now) {
        for (const e of [...this.queue]) {
            if (e.view.state !== "queued") {
                this.removeQueued(e);
                continue;
            }
            if (e.deadline !== undefined && now >= e.deadline) {
                this.removeQueued(e);
                this.finish(e, "failed", undefined, "QUEUE_WAIT_TIMEOUT");
            }
        }
    }
    attachment(e, onEvent, id, reused = false) {
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
            /** 本次附着是否复用已有逻辑执行（结果标记可见性用）。 */
            reused,
            /** 当前快照：供仅在停止等待时使用，不改变交付标记。 */
            snapshot: () => this.view(e),
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
        const previous = e.messages.get(m.messageId), fingerprint = hashMessage(m);
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
                    : (this.blockedBy(e) ?? "dispatch")
                : null,
            longRunning: e.view.state === "running" &&
                e.startedAt !== undefined &&
                (e.finishedAt ?? now) - e.startedAt >=
                    this.scheduler.longRunningMs,
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
        this.releaseResources(e);
        if (e.dedupeKey !== undefined &&
            this.dedupeIndex.get(e.dedupeKey) === e &&
            state !== "succeeded")
            this.dedupeIndex.delete(e.dedupeKey);
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
    /** 按会话轮转选择下一个可执行项：会话内按类别优先级 + 老化，跨会话公平。 */
    nextQueuedIndex(now) {
        const owners = this.readyOwners.length;
        for (let n = 0; n < owners; n++) {
            const owner = this.readyOwners.shift();
            let chosen = -1;
            let chosenScore = Infinity;
            for (let i = 0; i < this.queue.length; i++) {
                const e = this.queue[i];
                if (e.owner !== owner || !this.eligible(e))
                    continue;
                const score = this.effectivePriority(e, now);
                if (score < chosenScore) {
                    chosen = i;
                    chosenScore = score;
                }
            }
            if (chosen < 0) {
                // 该会话暂时全部被舱壁/资源阻塞；保留轮次，等释放后重新争取。
                if (this.queue.some((entry) => entry.owner === owner))
                    this.readyOwners.push(owner);
                continue;
            }
            if (this.queue.some((entry, i) => i !== chosen && entry.owner === owner))
                this.readyOwners.push(owner);
            return chosen;
        }
        return -1;
    }
    pump() {
        while (!this.closed) {
            const now = performance.now();
            this.expireQueued(now);
            if (this.running >= this.options.concurrency || this.queue.length === 0)
                return;
            const index = this.nextQueuedIndex(now);
            if (index < 0)
                return;
            const e = this.queue.splice(index, 1)[0];
            if (e.view.state !== "queued")
                continue;
            if (e.queueTimer !== undefined) {
                clearTimeout(e.queueTimer);
                e.queueTimer = undefined;
            }
            e.startedAt = performance.now();
            this.running++;
            this.runningByHandler.set(e.handler, (this.runningByHandler.get(e.handler) ?? 0) + 1);
            for (const resource of e.resources)
                this.resourceLocks.set(resource, e);
            e.view.state = "running";
            this.telemetry.record(e.trace, "started");
            this.emit(e, "started", {});
            void this.run(e).finally(() => {
                this.running--;
                const remaining = (this.runningByHandler.get(e.handler) ?? 1) - 1;
                if (remaining > 0)
                    this.runningByHandler.set(e.handler, remaining);
                else
                    this.runningByHandler.delete(e.handler);
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
            this.dedupeIndex.clear();
            this.resourceLocks.clear();
            this.runningByHandler.clear();
            this.retainedResultBytes = 0;
            this.queue = [];
            this.readyOwners = [];
            this.shutdownPhase = "closed";
        })().then(resolve, reject);
        return this.closing;
    }
}
