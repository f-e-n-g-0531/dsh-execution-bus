// Live observations only: never checkpoint these, or key them by a persisted ID.
const backoffs = new WeakMap();
export function setRetryBackoff(run, stepId, metadata) {
    let steps = backoffs.get(run);
    if (!steps) {
        steps = new Map();
        backoffs.set(run, steps);
    }
    steps.set(stepId, {
        waitingSince: metadata.waitingSince,
        nextRetryAt: metadata.nextRetryAt,
        retryCategory: metadata.retryCategory,
    });
}
export function clearRetryBackoff(run, stepId) {
    const steps = backoffs.get(run);
    steps?.delete(stepId);
    if (steps?.size === 0)
        backoffs.delete(run);
}
/** Scheduler means ready but not selected in a batch, not a capacity queue. */
export function runWaiting(run, settled) {
    const cleanupPending = settled === false && run.state !== "running";
    if (run.state !== "running")
        return { steps: [], cleanupPending };
    const done = new Set(run.steps
        .filter((step) => step.state === "succeeded")
        .map((step) => step.id));
    const specs = new Map(run.plan.steps.map((step) => [step.id, step]));
    const steps = run.steps
        .filter((step) => step.state === "pending")
        .map((step) => {
        const backoff = backoffs.get(run)?.get(step.id);
        if (backoff)
            return {
                stepId: step.id,
                reason: "retry_backoff",
                disposition: backoff.retryCategory === "transient" ||
                    backoff.retryCategory === "legacy_unknown"
                    ? "waiting_retry"
                    : "needs_action",
                ...backoff,
            };
        const spec = specs.get(step.id);
        return {
            stepId: step.id,
            reason: !spec || spec.dependsOn.some((id) => !done.has(id))
                ? "dependency"
                : "scheduler",
        };
    });
    return { steps, cleanupPending };
}
