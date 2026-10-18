import { randomUUID } from "node:crypto";
import { ERRORS } from "../error-codes.js";
import { RuntimeExecutor } from "./executor.js";
import { parsePlan } from "./plan.js";
import { RunStore } from "./store.js";
const MAX_ACTIVE_RUNS = 8;
const RUN_KEYS = new Set(["plan", "async"]);
const RUN_ID_KEYS = new Set(["runId"]);
function summary(run) {
    return {
        runId: run.runId,
        state: run.state,
        ...(run.goal === undefined ? {} : { goal: run.goal }),
        ...(run.error === undefined ? {} : { error: run.error }),
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        durationMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.createdAt),
        steps: run.steps.map((step) => ({
            id: step.id,
            tool: step.tool,
            state: step.state,
            attempts: step.attempts,
            ...(step.error === undefined ? {} : { error: step.error }),
        })),
    };
}
function plain(raw, keys) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
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
/** 每个预设作用域一个运行时服务：运行记录落盘、按会话隔离、可取消/恢复。 */
export class RuntimeService {
    ctx;
    store;
    active = new Map();
    constructor(ctx, store) {
        this.ctx = ctx;
        this.store = store ?? new RunStore();
        this.store.markInterrupted();
        this.store.prune(100);
    }
    dispose() {
        for (const entry of this.active.values())
            entry.controller.abort();
        this.active.clear();
    }
    async run(raw, exec, background = false) {
        const sessionId = this.sessionId(exec);
        const input = plain(raw, RUN_KEYS);
        const plan = parsePlan(input.plan);
        if (input.async !== undefined && typeof input.async !== "boolean")
            throw Error(ERRORS.INVALID_PLAN);
        if (this.active.size >= MAX_ACTIVE_RUNS)
            throw Error(ERRORS.RUNTIME_BUSY);
        const executor = this.executor(exec);
        const run = executor.createRun(sessionId, plan);
        const controller = new AbortController();
        const promise = executor
            .execute(run, controller.signal)
            .catch((error) => {
            run.state = "failed";
            run.error = ERRORS.RUNTIME_STEP_FAILED;
            run.finishedAt = Date.now();
            try {
                this.store.save(run);
            }
            catch { }
            throw error;
        });
        this.active.set(run.runId, { controller, promise });
        void promise
            .finally(() => this.active.delete(run.runId))
            .catch(() => { });
        if (background === true || input.async === true)
            return { runId: run.runId, state: "running" };
        return summary(await promise);
    }
    status(raw, exec) {
        const sessionId = this.sessionId(exec);
        const input = plain(raw, RUN_ID_KEYS);
        if (input.runId === undefined) {
            return {
                runs: this.store
                    .list(20)
                    .filter((run) => run.ownerSessionId === sessionId)
                    .map((run) => ({
                    runId: run.runId,
                    state: run.state,
                    ...(run.goal === undefined ? {} : { goal: run.goal }),
                    updatedAt: run.updatedAt,
                    stepCount: run.steps.length,
                })),
            };
        }
        const run = this.owned(input.runId, sessionId);
        return summary(run);
    }
    result(raw, exec) {
        const sessionId = this.sessionId(exec);
        const input = plain(raw, RUN_ID_KEYS);
        if (typeof input.runId !== "string")
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        const run = this.owned(input.runId, sessionId);
        return {
            ...summary(run),
            results: run.results,
            finished: run.state !== "running" && run.state !== "interrupted",
        };
    }
    cancel(raw, exec) {
        const sessionId = this.sessionId(exec);
        const input = plain(raw, RUN_ID_KEYS);
        if (typeof input.runId !== "string")
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        const run = this.owned(input.runId, sessionId);
        const active = this.active.get(run.runId);
        if (active)
            active.controller.abort();
        else
            this.executor(exec).cancel(run);
        try {
            this.store.save(run);
        }
        catch { }
        return summary(run);
    }
    async resume(raw, exec) {
        const sessionId = this.sessionId(exec);
        const input = plain(raw, RUN_ID_KEYS);
        if (typeof input.runId !== "string")
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        const run = this.owned(input.runId, sessionId);
        if (run.state !== "interrupted")
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        const executor = this.executor(exec);
        const controller = new AbortController();
        const promise = executor.resume(run, controller.signal);
        this.active.set(run.runId, { controller, promise });
        void promise
            .finally(() => this.active.delete(run.runId))
            .catch(() => { });
        return summary(await promise);
    }
    sessionId(exec) {
        if (!exec.agent)
            throw Error(ERRORS.OWNING_SESSION_REQUIRED);
        return String(exec.agent.id);
    }
    owned(runId, sessionId) {
        if (typeof runId !== "string")
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        const run = this.store.load(runId);
        if (!run || run.ownerSessionId !== sessionId)
            throw Error(ERRORS.RUNTIME_NOT_FOUND);
        return run;
    }
    executor(exec) {
        const self = this;
        const invoke = async (tool, input, signal) => {
            const result = await self.ctx.tools.execute({
                name: tool,
                callId: (String(exec.callId) + ":runtime:" + randomUUID()),
                rootCallId: exec.rootCallId,
                parent: exec.token,
                agent: exec.agent,
                arguments: input,
                signal,
            });
            if (result.isError)
                throw Error(ERRORS.RUNTIME_STEP_FAILED);
            return result.value;
        };
        return new RuntimeExecutor(this.store, invoke);
    }
}
