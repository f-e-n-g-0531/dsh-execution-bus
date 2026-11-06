import { randomUUID, createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { ToolExecutionPipeline } from "@deepseek-ai/dsh-tools/pipeline";
import { ERRORS } from "../error-codes.js";
import { runProgress, runGuidance } from "../presentation.js";
import { RuntimeExecutor } from "./executor.js";
import { parsePlan, RUNTIME_LIMITS } from "./plan.js";
import { runAcceptance, runRecovery } from "./insights.js";
import { runAttention } from "./attention.js";
import { runWaiting } from "./waiting.js";
import { ownerReview } from "./review.js";
import { executeAgent } from "./agent.js";
import { WorkerQuota } from "./worker-quota.js";
import { RunStore } from "./store.js";
const MAX_ACTIVE_RUNS = 8;
const PROCESS_ID = randomUUID();
const RUN_KEYS = new Set(["plan", "async"]);
const RUN_ID_KEYS = new Set(["runId"]);
const RESULT_KEYS = new Set(["runId", "stepId", "offset", "limit", "hash"]);
// Process-local settlement knowledge only; never infer cleanup after a restart.
const settlement = new Map();
function observeSettlement(runId, done) {
    settlement.delete(runId);
    settlement.set(runId, done);
    while (settlement.size > 1024)
        settlement.delete(settlement.keys().next().value);
}
const STATUS_KEYS = new Set(["runId", "limit", "offset"]);
// Shared only inside this module/process. A new Agent scope is not a process restart.
const managers = new Map();
function summary(run) {
    return {
        runId: run.runId,
        state: run.state,
        ...(run.goal === undefined ? {} : { goal: run.goal }),
        ...(run.plan.taskId === undefined ? {} : { taskId: run.plan.taskId }),
        ...(run.plan.previousRunId === undefined
            ? {}
            : { previousRunId: run.plan.previousRunId }),
        ...(run.error === undefined ? {} : { error: run.error }),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        durationMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.createdAt),
        ...(settlement.has(run.runId)
            ? { executionSettled: settlement.get(run.runId) }
            : {}),
        progress: runProgress(run),
        guidance: runGuidance(run),
        recovery: runRecovery(run, settlement.get(run.runId)),
        attention: runAttention(run, settlement.get(run.runId)),
        waiting: runWaiting(run, settlement.get(run.runId)),
        ownerReview: ownerReview(run),
        steps: run.steps.map((step) => ({
            id: step.id,
            tool: step.tool,
            state: step.state,
            attempts: step.attempts,
            ...(step.childSessionId === undefined
                ? {}
                : { childSessionId: step.childSessionId }),
            ...(step.workerTrace === undefined
                ? {}
                : { workerTrace: structuredClone(step.workerTrace) }),
            ...(step.error === undefined ? {} : { error: step.error }),
        })),
    };
}
function plain(raw, keys) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw Error(ERRORS.INVALID_PLAN);
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null)
        throw Error(ERRORS.INVALID_PLAN);
    const value = raw;
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !keys.has(key))
            throw Error(ERRORS.INVALID_PLAN);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!("value" in descriptor) || !descriptor.enumerable)
            throw Error(ERRORS.INVALID_PLAN);
    }
    return value;
}
function pageNumber(value, fallback, max) {
    if (value === undefined)
        return fallback;
    if (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > max)
        throw Error(ERRORS.INVALID_PLAN);
    return value;
}
function validateExecution(plan) {
    for (const step of plan.steps) {
        if (step.tool === "pwsh" && step.input.run_in_background === true)
            throw Error(ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED);
    }
}
/** Scope facade over a process-wide, root-keyed execution owner. */
export class RuntimeService {
    ctx;
    delegationPolicy;
    store;
    key;
    manager;
    closed = false;
    disposal;
    constructor(ctx, store, delegationPolicy) {
        this.ctx = ctx;
        this.delegationPolicy = delegationPolicy;
        this.store = store ?? new RunStore();
        const root = realpathSync(this.store.root);
        this.key = process.platform === "win32" ? root.toLowerCase() : root;
        const manager = managers.get(this.key) ?? {
            workerQuota: new WorkerQuota(),
            active: new Map(),
            failures: new Map(),
            references: 0,
        };
        this.store.maintain(new Set(manager.active.keys()), 100);
        manager.references++;
        this.manager = manager;
        managers.set(this.key, manager);
    }
    dispose() {
        if (this.disposal)
            return this.disposal;
        this.closed = true;
        const own = [...this.manager.active.values()].filter((entry) => entry.owner === this);
        // Cancel and abort synchronously: a host that drops the returned promise
        // or tears the process down right after dispose() still stops scheduling
        // and gets terminal checkpoints. Only the settlement await stays async.
        for (const entry of own) {
            try {
                entry.executor.cancel(entry.run);
            }
            catch {
                this.rememberStorageFailure(entry.run);
            }
            finally {
                entry.controller.abort();
            }
        }
        this.disposal = (async () => {
            await Promise.allSettled(own.map((entry) => entry.promise));
            this.manager.references--;
            this.releaseManager();
        })();
        return this.disposal;
    }
    /** Descriptive only: no policy checks, tool dispatch, capacity reservation or run creation. */
    capabilities(raw, exec) {
        this.ensureOpen();
        this.sessionId(exec);
        plain(raw, new Set());
        const adapter = typeof this.delegationPolicy?.checkParentPolicy === "function";
        const parentAdmission = exec.toolSet !== undefined;
        return {
            ordinaryDag: "supported",
            worker: adapter && parentAdmission
                ? "conditional"
                : "unavailable",
            workerReason: !adapter
                ? "trusted_adapter_missing"
                : !parentAdmission
                    ? "parent_admission_missing"
                    : "execution_checks_required",
            ordinaryAsync: !parentAdmission,
            workerAsync: false,
            workerTools: ["read", "glob", "grep"],
            limits: {
                maxSteps: RUNTIME_LIMITS.steps,
                maxConcurrency: RUNTIME_LIMITS.concurrencyMax,
                maxActiveRuns: MAX_ACTIVE_RUNS,
                maxWorkers: 8,
            },
            authorization: "checked_at_execution",
            message: "能力说明不代表授权、工具/模型可用或容量预留；每次执行仍须通过宿主准入。Worker 需要可信父策略适配器及有效父 toolSet；普通异步调用仅适用于无 toolSet 的受控宿主集成。",
        };
    }
    async run(raw, exec, background = false) {
        this.ensureOpen();
        const sessionId = this.sessionId(exec);
        const input = plain(raw, RUN_KEYS);
        const plan = parsePlan(input.plan);
        if (input.async !== undefined && typeof input.async !== "boolean")
            throw Error(ERRORS.INVALID_PLAN);
        validateExecution(plan);
        // Step admission closes when the outer call returns. Never detach a worker
        // with a dead parent toolSet or synthesize a broader replacement admission.
        if ((background || input.async === true) &&
            plan.steps.some((step) => step.tool === "agent"))
            throw Error(ERRORS.RUNTIME_AGENT_ASYNC_UNSUPPORTED);
        // Ordinary nested tools also lose their step admission after detaching.
        // Do not drop or re-resolve it to synthesize broader host permissions.
        if ((background || input.async === true) && exec.toolSet !== undefined)
            throw Error(ERRORS.RUNTIME_ASYNC_ADMISSION_UNSUPPORTED);
        if (plan.previousRunId !== undefined) {
            const previous = this.owned(plan.previousRunId, sessionId);
            if (previous.plan.taskId !== plan.taskId ||
                !["succeeded", "failed", "cancelled"].includes(previous.state) ||
                this.manager.active.has(previous.runId))
                throw Error(ERRORS.RUNTIME_TASK_LINK_INVALID);
        }
        if (plan.steps.some((step) => step.tool === "agent") &&
            typeof this.delegationPolicy?.checkParentPolicy !== "function")
            throw Error(ERRORS.RUNTIME_AGENT_POLICY_UNSUPPORTED);
        this.admit(exec);
        const executor = this.executor(exec);
        const run = executor.createRun(sessionId, plan, {
            ownerPid: process.pid,
            ownerProcess: PROCESS_ID,
        });
        const detached = background === true || input.async === true;
        const promise = this.start(run, executor, exec, false, detached);
        if (detached)
            return { runId: run.runId, state: "running" };
        return summary(await promise);
    }
    status(raw, exec) {
        this.ensureOpen();
        const sessionId = this.sessionId(exec);
        const input = plain(raw, STATUS_KEYS);
        if (input.runId === undefined) {
            const limit = pageNumber(input.limit, 20, 100);
            if (limit === 0)
                throw Error(ERRORS.INVALID_PLAN);
            const offset = pageNumber(input.offset, 0, 10_000);
            const volatile = [
                ...this.manager.failures.values(),
                ...[...this.manager.active.values()].map((e) => e.run),
            ].filter((run) => run.ownerSessionId === sessionId);
            const records = new Map(this.store
                .list(offset + limit + volatile.length, sessionId)
                .map((run) => [run.runId, run]));
            for (const run of volatile)
                records.set(run.runId, run);
            return {
                runs: [...records.values()]
                    .sort((a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId))
                    .slice(offset, offset + limit)
                    .map((run) => ({
                    runId: run.runId,
                    state: run.state,
                    ...(run.goal === undefined ? {} : { goal: run.goal }),
                    ...(run.plan.taskId === undefined
                        ? {}
                        : { taskId: run.plan.taskId }),
                    ...(run.plan.previousRunId === undefined
                        ? {}
                        : { previousRunId: run.plan.previousRunId }),
                    ...(run.error === undefined ? {} : { error: run.error }),
                    updatedAt: run.updatedAt,
                    stepCount: run.steps.length,
                    progress: runProgress(run),
                    guidance: runGuidance(run),
                    attention: runAttention(run, settlement.get(run.runId)),
                    waiting: runWaiting(run, settlement.get(run.runId)),
                    ownerReview: ownerReview(run),
                })),
                diagnostics: this.store.diagnostics(),
            };
        }
        if (input.limit !== undefined || input.offset !== undefined)
            throw Error(ERRORS.INVALID_PLAN);
        return summary(this.owned(input.runId, sessionId));
    }
    acknowledge(raw, exec) {
        this.ensureOpen();
        const sessionId = this.sessionId(exec);
        const input = plain(raw, new Set(["runId", "snapshotHash", "key", "expectedRevision", "reason"]));
        const run = this.owned(input.runId, sessionId);
        if (exec.signal?.aborted)
            throw Error(ERRORS.RUNTIME_CANCELLED);
        if (this.manager.active.has(run.runId) ||
            this.manager.failures.has(run.runId) ||
            run.state === "running" ||
            run.state === "interrupted")
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        if (typeof input.snapshotHash !== "string" ||
            !/^[a-f0-9]{64}$/.test(input.snapshotHash) ||
            typeof input.key !== "string" ||
            !/^[a-f0-9]{64}$/.test(input.key) ||
            typeof input.expectedRevision !== "number" ||
            !Number.isSafeInteger(input.expectedRevision) ||
            input.expectedRevision < 0 ||
            typeof input.reason !== "string" ||
            !input.reason.trim() ||
            Buffer.byteLength(input.reason, "utf8") > 2048)
            throw Error(ERRORS.INVALID_PLAN);
        const saved = this.store.recordAcknowledgement(run.runId, sessionId, {
            snapshotHash: input.snapshotHash,
            key: input.key,
            expectedRevision: input.expectedRevision,
            reason: input.reason,
        });
        return {
            ...summary(saved),
            acknowledgementHistory: saved.acknowledgements,
        };
    }
    review(raw, exec) {
        this.ensureOpen();
        const sessionId = this.sessionId(exec);
        const input = plain(raw, new Set([
            "runId",
            "snapshotHash",
            "expectedRevision",
            "disposition",
            "reason",
        ]));
        const run = this.owned(input.runId, sessionId);
        if (exec.signal?.aborted)
            throw Error(ERRORS.RUNTIME_CANCELLED);
        if (this.manager.active.has(run.runId) ||
            this.manager.failures.has(run.runId))
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        if (typeof input.snapshotHash !== "string" ||
            !/^[a-f0-9]{64}$/.test(input.snapshotHash) ||
            typeof input.expectedRevision !== "number" ||
            !Number.isSafeInteger(input.expectedRevision) ||
            input.expectedRevision < 0 ||
            (input.disposition !== "accepted" &&
                input.disposition !== "needs_work") ||
            typeof input.reason !== "string" ||
            !input.reason.trim() ||
            Buffer.byteLength(input.reason, "utf8") > 2048)
            throw Error(ERRORS.INVALID_PLAN);
        const saved = this.store.recordReview(run.runId, sessionId, {
            snapshotHash: input.snapshotHash,
            expectedRevision: input.expectedRevision,
            disposition: input.disposition,
            reason: input.reason,
        });
        return { ...summary(saved), ownerReviewHistory: saved.ownerReviews };
    }
    result(raw, exec) {
        this.ensureOpen();
        const input = plain(raw, RESULT_KEYS);
        const run = this.owned(input.runId, this.sessionId(exec));
        if (input.stepId !== undefined) {
            if (typeof input.stepId !== "string" ||
                !run.steps.some((s) => s.id === input.stepId))
                throw Error(ERRORS.RUNTIME_NOT_FOUND);
            const stored = Object.hasOwn(run.results, input.stepId)
                ? run.results[input.stepId]
                : undefined;
            if (!stored || stored.truncated || !Object.hasOwn(stored, "value"))
                throw Error(ERRORS.RUNTIME_RESULT_UNAVAILABLE);
            const text = JSON.stringify(stored.value);
            const hash = createHash("sha256").update(text).digest("hex");
            if (input.hash !== undefined && input.hash !== hash)
                throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
            // Code-point offsets never split surrogate pairs. Each page is <= 16KiB UTF-8.
            const chars = Array.from(text);
            const offset = pageNumber(input.offset, 0, chars.length);
            const limit = pageNumber(input.limit, 2048, 4096);
            if (!limit)
                throw Error(ERRORS.INVALID_PLAN);
            const end = Math.min(chars.length, offset + limit);
            return {
                ...summary(run),
                acceptance: runAcceptance(run),
                ownerReviewHistory: run.ownerReviews ?? [],
                acknowledgementHistory: run.acknowledgements ?? [],
                results: {},
                finished: run.state !== "running" && run.state !== "interrupted",
                page: {
                    stepId: input.stepId,
                    encoding: "json",
                    unit: "unicode_code_point",
                    hash,
                    offset,
                    total: chars.length,
                    text: chars.slice(offset, end).join(""),
                    ...(end < chars.length ? { nextOffset: end } : {}),
                },
            };
        }
        if (input.offset !== undefined ||
            input.limit !== undefined ||
            input.hash !== undefined)
            throw Error(ERRORS.INVALID_PLAN);
        return {
            ...summary(run),
            acceptance: runAcceptance(run),
            ownerReviewHistory: run.ownerReviews ?? [],
            acknowledgementHistory: run.acknowledgements ?? [],
            results: structuredClone(run.results),
            finished: run.state !== "running" && run.state !== "interrupted",
        };
    }
    cancel(raw, exec) {
        this.ensureOpen();
        const input = plain(raw, RUN_ID_KEYS);
        const run = this.owned(input.runId, this.sessionId(exec));
        const entry = this.manager.active.get(run.runId);
        if (entry) {
            try {
                entry.executor.cancel(entry.run);
            }
            catch {
                this.rememberStorageFailure(entry.run);
                throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
            }
            finally {
                entry.controller.abort();
            }
        }
        else {
            if (run.state === "running")
                throw Error(ERRORS.RUNTIME_BUSY);
            try {
                this.executor(exec).cancel(run);
            }
            catch {
                this.rememberStorageFailure(run);
                throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
            }
            try {
                this.store.prune(100);
            }
            catch {
                /* Retention failures do not reverse cancellation. */
            }
        }
        // Scheduling cancellation is not confirmation that an uncooperative tool stopped.
        return summary(run);
    }
    async resume(raw, exec) {
        this.ensureOpen();
        const input = plain(raw, RUN_ID_KEYS);
        const run = this.owned(input.runId, this.sessionId(exec));
        if (run.state !== "interrupted" || this.manager.active.has(run.runId))
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        validateExecution(run.plan);
        if (run.plan.steps.some((step) => step.tool === "agent") &&
            typeof this.delegationPolicy?.checkParentPolicy !== "function")
            throw Error(ERRORS.RUNTIME_AGENT_POLICY_UNSUPPORTED);
        this.admit(exec);
        return summary(await this.start(run, this.executor(exec), exec, true, false));
    }
    start(run, executor, exec, resume, detached) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        if (!detached)
            exec.signal?.addEventListener("abort", onAbort, { once: true });
        run.ownerPid = process.pid;
        run.ownerProcess = PROCESS_ID;
        const entry = {
            owner: this,
            run,
            executor,
            controller,
            promise: undefined,
        };
        // Register before arbitrary host code, including synchronous re-entrancy.
        this.manager.active.set(run.runId, entry);
        observeSettlement(run.runId, false);
        const promise = Promise.resolve()
            .then(() => {
            if (exec.signal?.aborted && !detached)
                controller.abort();
            this.store.save(run);
            if (run.state === "cancelled")
                return run;
            return resume
                ? executor.resume(run, controller.signal)
                : executor.execute(run, controller.signal);
        })
            .catch((error) => {
            run.state = "failed";
            run.error =
                error instanceof Error &&
                    error.message === ERRORS.RUNTIME_STORAGE_FAILED
                    ? ERRORS.RUNTIME_STORAGE_FAILED
                    : ERRORS.RUNTIME_STEP_FAILED;
            run.finishedAt = run.updatedAt = Math.max(Date.now(), run.updatedAt, run.createdAt, run.finishedAt ?? 0, ...run.steps.flatMap((step) => [
                step.startedAt ?? 0,
                step.finishedAt ?? 0,
            ]));
            try {
                this.store.save(run);
            }
            catch {
                this.rememberStorageFailure(run);
            }
            throw error;
        })
            .finally(() => {
            // Eviction means unknown, never a fabricated cleanup success.
            observeSettlement(run.runId, true);
            exec.signal?.removeEventListener("abort", onAbort);
            if (this.manager.active.get(run.runId) === entry)
                this.manager.active.delete(run.runId);
            try {
                this.store.prune(100);
            }
            catch {
                /* Cleanup failure cannot reverse a completed operation. */
            }
            this.releaseManager();
        });
        entry.promise = promise;
        void promise.catch(() => { });
        return promise;
    }
    rememberStorageFailure(run) {
        run.state = "failed";
        run.error = ERRORS.RUNTIME_STORAGE_FAILED;
        run.finishedAt = run.updatedAt = Math.max(Date.now(), run.updatedAt, run.createdAt, run.finishedAt ?? 0, ...run.steps.flatMap((step) => [
            step.startedAt ?? 0,
            step.finishedAt ?? 0,
        ]));
        this.manager.failures.set(run.runId, run);
        if (this.manager.failures.size > 100)
            this.manager.failures.delete(this.manager.failures.keys().next().value);
    }
    releaseManager() {
        if (this.manager.references === 0 &&
            this.manager.active.size === 0 &&
            managers.get(this.key) === this.manager)
            managers.delete(this.key);
    }
    ensureOpen() {
        if (this.closed)
            throw Error(ERRORS.CLOSED);
    }
    admit(exec) {
        if (exec.signal?.aborted)
            throw Error(ERRORS.RUNTIME_CANCELLED);
        if (this.manager.active.size >= MAX_ACTIVE_RUNS)
            throw Error(ERRORS.RUNTIME_BUSY);
    }
    sessionId(exec) {
        if (!exec.agent || !String(exec.agent.id ?? ""))
            throw Error(ERRORS.OWNING_SESSION_REQUIRED);
        return String(exec.agent.id);
    }
    owned(runId, sessionId) {
        if (typeof runId !== "string")
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        const run = this.manager.active.get(runId)?.run ??
            this.manager.failures.get(runId) ??
            this.store.load(runId);
        if (!run || run.ownerSessionId !== sessionId)
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        return run;
    }
    executor(exec) {
        const invoke = async (tool, input, signal, onCreated) => {
            if (tool === "agent") {
                // Reserve before any host creation code, including synchronous re-entry.
                // Never queue or detach workers behind the parent admission lifetime.
                const release = this.manager.workerQuota.reserve();
                try {
                    const { trace: _trace, ...result } = await executeAgent(this.ctx, exec, input, signal, onCreated, onCreated, this.delegationPolicy);
                    // Audit metadata is already checkpointed in StepRecord. Keep it outside
                    // the legacy result quota and dependency prompt to preserve text budgets.
                    return result;
                }
                finally {
                    // executeAgent settles only after its awaited handle.dispose(). Neither
                    // abort nor RuntimeService.dispose may release this reservation early.
                    release();
                }
            }
            const pipeline = new ToolExecutionPipeline(this.ctx);
            const prepared = await pipeline.prepare({
                name: tool,
                callId: (String(exec.callId) +
                    ":runtime:" +
                    randomUUID()),
                rootCallId: exec.rootCallId,
                parent: exec.token,
                agent: exec.agent,
                toolSet: exec.toolSet,
                arguments: input,
                signal,
            });
            const outcome = prepared.kind === "dispatch"
                ? await pipeline.dispatch(prepared.exec)
                : prepared;
            const result = await pipeline.complete(prepared.exec, outcome);
            if (result.isError) {
                // Canonical host error codes only; never inspect content/message or tool values.
                // rc.1 may omit raw status/errno, which cannot safely be reconstructed.
                const error = Error(ERRORS.RUNTIME_STEP_FAILED);
                const code = result.error?.info?.code;
                if (typeof code === "string")
                    Object.assign(error, { code });
                throw error;
            }
            if (tool === "pwsh") {
                const value = result.value;
                if (value?.kind === "background" || value?.kind === "promoted") {
                    throw Object.assign(Error(ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED), {
                        result: { kind: value.kind, jobId: value.jobId },
                    });
                }
                const sandbox = value?.sandbox;
                if (value?.timedOut)
                    throw Error(ERRORS.RUNTIME_STEP_TIMEOUT);
                if (value?.aborted || value?.signal || value?.stopped)
                    throw Object.assign(Error(ERRORS.RUNTIME_COMMAND_FAILED), {
                        unknownSideEffect: true,
                    });
                if (!value ||
                    value.exitCode !== 0 ||
                    value.aborted ||
                    value.timedOut ||
                    value.signal ||
                    value.stopped ||
                    sandbox?.denied ||
                    sandbox?.runnerFailed)
                    throw Error(ERRORS.RUNTIME_COMMAND_FAILED);
            }
            return result.value;
        };
        return new RuntimeExecutor(this.store, invoke);
    }
}
