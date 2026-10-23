import { randomUUID } from "node:crypto";
import { ERRORS } from "../error-codes.js";
import { IDEMPOTENT_TOOLS, RUNTIME_LIMITS } from "./plan.js";
/** 按批次 DAG 执行；每次调用前及完成/重试时落盘，存储故障必须停止调度。 */
export class RuntimeExecutor {
    store;
    invoke;
    executions = new WeakMap();
    constructor(store, invoke) {
        this.store = store;
        this.invoke = invoke;
    }
    createRun(ownerSessionId, plan, owner) {
        const now = Date.now();
        const run = {
            version: 1,
            runId: "run-" + randomUUID(),
            ownerSessionId,
            ...(owner ?? {}),
            ...(plan.goal === undefined ? {} : { goal: plan.goal }),
            plan,
            state: "running",
            steps: plan.steps.map((step) => ({
                id: step.id,
                tool: step.tool,
                state: "pending",
                attempts: 0,
            })),
            results: {},
            createdAt: now,
            updatedAt: now,
        };
        this.checkpoint(run);
        return run;
    }
    async execute(run, signal) {
        if (this.terminal(run))
            return run;
        if (this.executions.has(run))
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        const execution = { controller: new AbortController() };
        this.executions.set(run, execution);
        // AbortSignal dispatch cannot propagate a thrown save error to execute().
        const onAbort = () => {
            try {
                this.cancel(run);
            }
            catch (error) {
                execution.storageError = error;
            }
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
            if (signal?.aborted)
                onAbort();
            if (execution.storageError)
                throw execution.storageError;
            if (this.terminal(run))
                return run;
            run.state = "running";
            run.error = undefined;
            run.finishedAt = undefined;
            this.checkpoint(run);
            while (!this.terminal(run)) {
                // A restored/pre-existing failure must never let an unrelated pending write run.
                const failed = run.steps.find((step) => step.state === "failed" || step.state === "unknown");
                if (failed) {
                    run.state = "failed";
                    run.error = failed.error ?? ERRORS.RUNTIME_STEP_FAILED;
                    break;
                }
                const pending = run.steps.filter((step) => step.state === "pending");
                if (pending.length === 0) {
                    run.state = run.steps.every((step) => step.state === "succeeded")
                        ? "succeeded"
                        : "cancelled";
                    break;
                }
                const done = new Set(run.steps
                    .filter((step) => step.state === "succeeded")
                    .map((step) => step.id));
                const ready = pending.filter((record) => {
                    const spec = this.spec(run, record.id);
                    return (spec !== undefined && spec.dependsOn.every((dep) => done.has(dep)));
                });
                if (ready.length === 0) {
                    run.state = "failed";
                    run.error = ERRORS.RUNTIME_INVALID_STATE;
                    break;
                }
                const outcomes = await Promise.allSettled(ready
                    .slice(0, run.plan.concurrency)
                    .map((record) => this.runStep(run, record, execution)));
                // Never turn a rejected checkpoint into a successful batch. All siblings
                // have stopped their local races before this error leaves execute().
                if (execution.storageError)
                    throw execution.storageError;
                const rejected = outcomes.find((outcome) => outcome.status === "rejected");
                if (rejected?.status === "rejected")
                    throw rejected.reason;
            }
            if (execution.storageError)
                throw execution.storageError;
            // cancel() already committed the terminal cancellation checkpoint.
            if (run.state !== "cancelled") {
                run.finishedAt = this.now(run);
                this.checkpoint(run);
            }
            return run;
        }
        finally {
            signal?.removeEventListener("abort", onAbort);
            execution.controller.abort();
            this.executions.delete(run);
        }
    }
    /** 未知副作用不得重放；出现这种失败时整个恢复运行停止，不启动无关 pending 写。 */
    async resume(run, signal) {
        if (run.state !== "interrupted")
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        for (const record of run.steps) {
            if (record.state !== "running" && record.state !== "unknown")
                continue;
            if (IDEMPOTENT_TOOLS.has(record.tool)) {
                record.state = "pending";
                record.error = undefined;
                record.startedAt = undefined;
                record.finishedAt = undefined;
            }
            else {
                record.state = "failed";
                record.error = ERRORS.RUNTIME_INTERRUPTED;
                record.finishedAt = this.now(run);
            }
        }
        const failed = run.steps.find((record) => record.state === "failed");
        run.state = failed ? "failed" : "running";
        run.error = failed?.error;
        run.finishedAt = failed ? this.now(run) : undefined;
        this.checkpoint(run);
        return failed ? run : this.execute(run, signal);
    }
    cancel(run, reason = ERRORS.RUNTIME_CANCELLED) {
        if (this.terminal(run))
            return;
        run.state = "cancelled";
        run.error = reason;
        const now = this.now(run);
        run.finishedAt = now;
        for (const record of run.steps) {
            if (record.state !== "pending" && record.state !== "running")
                continue;
            record.state =
                record.state === "running" && !IDEMPOTENT_TOOLS.has(record.tool)
                    ? "unknown"
                    : "cancelled";
            record.error = reason;
            record.finishedAt = now;
        }
        try {
            this.checkpoint(run);
        }
        finally {
            this.executions.get(run)?.controller.abort();
        }
    }
    terminal(run) {
        return (run.state === "succeeded" ||
            run.state === "failed" ||
            run.state === "cancelled");
    }
    spec(run, id) {
        return run.plan.steps.find((step) => step.id === id);
    }
    async runStep(run, record, execution) {
        const spec = this.spec(run, record.id);
        if (!spec)
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        const attemptsAllowed = IDEMPOTENT_TOOLS.has(spec.tool)
            ? spec.retry + 1
            : 1;
        for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
            if (execution.controller.signal.aborted || this.terminal(run))
                return;
            record.state = "running";
            record.startedAt = this.now(run);
            record.finishedAt = undefined;
            record.error = undefined;
            record.attempts++;
            this.checkpoint(run);
            const outcome = await this.attempt(spec, execution.controller.signal);
            // Cancellation/storage failure owns the record from now on. Late tool
            // resolution has no mutation callback, and cannot publish results.
            if (execution.controller.signal.aborted || this.terminal(run))
                return;
            if (outcome.kind === "success") {
                record.state = "succeeded";
                run.results[spec.id] = boundedResult(outcome.value);
            }
            else if (outcome.kind === "stopped") {
                return;
            }
            else {
                record.error =
                    outcome.kind === "timeout"
                        ? ERRORS.RUNTIME_STEP_TIMEOUT
                        : stepError(outcome.error);
                const background = record.error === ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED;
                const timedOut = outcome.kind === "timeout" ||
                    record.error === ERRORS.RUNTIME_STEP_TIMEOUT;
                const uncertain = outcome.kind === "failure" &&
                    outcome.error instanceof Error &&
                    record.error === ERRORS.RUNTIME_COMMAND_FAILED &&
                    outcome.error
                        .unknownSideEffect === true;
                if (background &&
                    outcome.kind === "failure" &&
                    outcome.error instanceof Error &&
                    Object.hasOwn(outcome.error, "result")) {
                    run.results[spec.id] = boundedResult(outcome.error.result);
                }
                // A timed-out read may still be executing in a non-cooperative host.
                // Do not overlap a retry, even for a nominally idempotent tool.
                const retry = outcome.kind === "failure" &&
                    !background &&
                    !timedOut &&
                    !uncertain &&
                    attempt < attemptsAllowed;
                record.state = retry
                    ? "pending"
                    : background ||
                        ((timedOut || uncertain) && !IDEMPOTENT_TOOLS.has(spec.tool))
                        ? "unknown"
                        : "failed";
                record.finishedAt = retry ? undefined : this.now(run);
                this.checkpoint(run);
                if (retry) {
                    await waitForRetry(100 * attempt, execution.controller.signal);
                    continue;
                }
                return;
            }
            record.finishedAt = this.now(run);
            this.checkpoint(run);
            return;
        }
    }
    async attempt(spec, signal) {
        if (signal.aborted)
            return { kind: "stopped" };
        const controller = new AbortController();
        let stop;
        const stopped = new Promise((resolve) => {
            stop = resolve;
        });
        const onAbort = () => {
            stop({ kind: "stopped" });
            controller.abort();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => {
            // Resolve timeout before aborting: cooperative host rejection must not
            // disguise a timeout as a normal retryable failure.
            stop({ kind: "timeout" });
            controller.abort();
        }, spec.timeoutMs);
        try {
            const invoked = Promise.resolve().then(async () => {
                if (signal.aborted)
                    return { kind: "stopped" };
                try {
                    return {
                        kind: "success",
                        value: await this.invoke(spec.tool, spec.input, controller.signal),
                    };
                }
                catch (error) {
                    return { kind: "failure", error };
                }
            });
            return await Promise.race([stopped, invoked]);
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
        }
    }
    now(run) {
        return Math.max(Date.now(), run.createdAt, run.updatedAt, run.finishedAt ?? 0, ...run.steps.flatMap((step) => [
            step.startedAt ?? 0,
            step.finishedAt ?? 0,
        ]));
    }
    checkpoint(run) {
        const execution = this.executions.get(run);
        if (execution?.storageError)
            throw execution.storageError;
        run.updatedAt = this.now(run);
        if (this.terminal(run))
            run.finishedAt = run.updatedAt;
        try {
            this.store.save(run);
        }
        catch (cause) {
            const error = new Error(ERRORS.RUNTIME_STORAGE_FAILED, { cause });
            run.state = "failed";
            run.error = ERRORS.RUNTIME_STORAGE_FAILED;
            run.finishedAt = run.updatedAt = this.now(run);
            for (const record of run.steps) {
                if (record.state !== "running")
                    continue;
                record.state = IDEMPOTENT_TOOLS.has(record.tool) ? "failed" : "unknown";
                record.error = ERRORS.RUNTIME_STORAGE_FAILED;
                record.finishedAt = run.finishedAt;
            }
            if (execution) {
                execution.storageError = error;
                execution.controller.abort();
            }
            throw error;
        }
    }
}
function stepError(error) {
    const message = error instanceof Error ? error.message : "";
    return message === ERRORS.RUNTIME_COMMAND_FAILED ||
        message === ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED ||
        message === ERRORS.RUNTIME_STEP_TIMEOUT
        ? message
        : ERRORS.RUNTIME_STEP_FAILED;
}
function waitForRetry(ms, signal) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        signal.addEventListener("abort", finish, { once: true });
    });
}
function boundedResult(value) {
    try {
        const json = JSON.stringify(value);
        if (json === undefined)
            return { value: null, bytes: 0 };
        const bytes = Buffer.byteLength(json);
        if (bytes > RUNTIME_LIMITS.resultBytes)
            return { truncated: true, bytes };
        return { value: JSON.parse(json), bytes };
    }
    catch {
        return { truncated: true };
    }
}
