import { ERRORS } from "../error-codes.js";
import { IDEMPOTENT_TOOLS, RUNTIME_LIMITS } from "./plan.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 按 DAG 执行声明式计划：独立步骤并行、幂等步骤可重试、逐步落盘、可取消/恢复。 */
export class RuntimeExecutor {
    store;
    invoke;
    constructor(store, invoke) {
        this.store = store;
        this.invoke = invoke;
    }
    createRun(ownerSessionId, plan) {
        const now = Date.now();
        const runId = "run-" +
            now.toString(36) +
            "-" +
            Math.random().toString(36).slice(2, 10);
        const run = {
            version: 1,
            runId,
            ownerSessionId,
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
        this.store.save(run);
        return run;
    }
    async execute(run, signal) {
        if (run.state === "succeeded" || run.state === "failed" || run.state === "cancelled")
            return run;
        run.state = "running";
        run.error = undefined;
        run.finishedAt = undefined;
        this.touch(run);
        this.store.save(run);
        while (true) {
            if (signal?.aborted) {
                this.cancel(run);
                return run;
            }
            const pending = run.steps.filter((step) => step.state === "pending");
            if (pending.length === 0)
                break;
            const done = new Set(run.steps.filter((step) => step.state === "succeeded").map((step) => step.id));
            const ready = pending.filter((record) => {
                const spec = this.spec(run, record.id);
                return spec !== undefined && spec.dependsOn.every((dep) => done.has(dep));
            });
            if (ready.length === 0) {
                run.state = "failed";
                run.error = ERRORS.RUNTIME_INVALID_STATE;
                break;
            }
            const batch = ready.slice(0, run.plan.concurrency);
            for (const record of batch) {
                record.state = "running";
                record.startedAt = Date.now();
                record.attempts++;
            }
            this.touch(run);
            this.store.save(run);
            await Promise.allSettled(batch.map((record) => this.runStep(run, record, signal)));
            this.touch(run);
            this.store.save(run);
            const failedStep = batch.find((record) => record.state === "failed");
            if (failedStep) {
                run.state = "failed";
                run.error = failedStep.error ?? ERRORS.RUNTIME_STEP_FAILED;
                break;
            }
            if (batch.some((record) => record.state === "unknown" || record.state === "cancelled")) {
                run.state = "cancelled";
                break;
            }
        }
        if (run.state === "running") {
            const failed = run.steps.find((step) => step.state === "failed");
            if (failed) {
                run.state = "failed";
                run.error = failed.error ?? ERRORS.RUNTIME_STEP_FAILED;
            }
            else if (run.steps.some((step) => step.state === "unknown")) {
                run.state = "cancelled";
            }
            else {
                run.state = "succeeded";
            }
        }
        run.finishedAt = Date.now();
        this.touch(run);
        this.store.save(run);
        return run;
    }
    /** 只恢复 interrupted 运行：幂等步骤重排，副作用步骤保持 unknown/failed。 */
    async resume(run, signal) {
        if (run.state !== "interrupted")
            throw Error(ERRORS.RUNTIME_INVALID_STATE);
        for (const record of run.steps) {
            if (record.state !== "running" && record.state !== "unknown")
                continue;
            const spec = this.spec(run, record.id);
            if (spec && IDEMPOTENT_TOOLS.has(spec.tool)) {
                record.state = "pending";
                record.error = undefined;
            }
            else {
                record.state = "failed";
                record.error = ERRORS.RUNTIME_INTERRUPTED;
            }
        }
        run.state = "running";
        run.error = undefined;
        run.finishedAt = undefined;
        this.touch(run);
        this.store.save(run);
        return this.execute(run, signal);
    }
    cancel(run, reason = ERRORS.RUNTIME_CANCELLED) {
        if (run.state === "succeeded" ||
            run.state === "failed" ||
            run.state === "cancelled")
            return;
        run.state = "cancelled";
        run.error = reason;
        run.finishedAt = Date.now();
        for (const record of run.steps) {
            if (record.state === "pending") {
                record.state = "cancelled";
                record.error = reason;
                record.finishedAt = Date.now();
            }
            else if (record.state === "running") {
                record.state = "unknown";
                record.error = reason;
                record.finishedAt = Date.now();
            }
        }
        this.touch(run);
        this.store.save(run);
    }
    spec(run, id) {
        return run.plan.steps.find((step) => step.id === id);
    }
    async runStep(run, record, runSignal) {
        const spec = this.spec(run, record.id);
        if (!spec) {
            record.state = "failed";
            record.error = ERRORS.RUNTIME_INVALID_STATE;
            record.finishedAt = Date.now();
            return;
        }
        const attemptsAllowed = spec.retry + 1;
        for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
            if (runSignal?.aborted) {
                record.state = IDEMPOTENT_TOOLS.has(spec.tool) ? "cancelled" : "unknown";
                record.error = ERRORS.RUNTIME_CANCELLED;
                record.finishedAt = Date.now();
                return;
            }
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            runSignal?.addEventListener("abort", onAbort, { once: true });
            let timer;
            try {
                const timeout = new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        controller.abort();
                        reject(Error(ERRORS.RUNTIME_STEP_TIMEOUT));
                    }, spec.timeoutMs);
                });
                const value = await Promise.race([
                    this.invoke(spec.tool, spec.input, controller.signal),
                    timeout,
                ]);
                record.state = "succeeded";
                record.error = undefined;
                record.finishedAt = Date.now();
                run.results[spec.id] = boundedResult(value);
                return;
            }
            catch (error) {
                const aborted = runSignal?.aborted === true;
                const message = error instanceof Error ? error.message : "";
                record.error = aborted
                    ? ERRORS.RUNTIME_CANCELLED
                    : message === ERRORS.RUNTIME_STEP_TIMEOUT
                        ? ERRORS.RUNTIME_STEP_TIMEOUT
                        : ERRORS.RUNTIME_STEP_FAILED;
                if (aborted) {
                    record.state = IDEMPOTENT_TOOLS.has(spec.tool)
                        ? "cancelled"
                        : "unknown";
                    record.finishedAt = Date.now();
                    return;
                }
                if (attempt < attemptsAllowed) {
                    record.attempts++;
                    await delay(100 * attempt);
                    continue;
                }
                record.state = "failed";
                record.finishedAt = Date.now();
                return;
            }
            finally {
                if (timer !== undefined)
                    clearTimeout(timer);
                runSignal?.removeEventListener("abort", onAbort);
            }
        }
    }
    touch(run) {
        run.updatedAt = Date.now();
    }
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
