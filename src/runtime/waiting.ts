import type { RetryCategory } from "./retry.js";
import type { RunRecord } from "./store.js";

export interface RetryBackoff {
  waitingSince: number;
  nextRetryAt: number;
  retryCategory: RetryCategory;
}

export interface WaitingStep {
  stepId: string;
  reason: "dependency" | "scheduler" | "retry_backoff";
  waitingSince?: number;
  nextRetryAt?: number;
  retryCategory?: RetryCategory;
}

// Live observations only: never checkpoint these, or key them by a persisted ID.
const backoffs = new WeakMap<RunRecord, Map<string, RetryBackoff>>();

export function setRetryBackoff(
  run: RunRecord,
  stepId: string,
  metadata: RetryBackoff,
): void {
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

export function clearRetryBackoff(run: RunRecord, stepId: string): void {
  const steps = backoffs.get(run);
  steps?.delete(stepId);
  if (steps?.size === 0) backoffs.delete(run);
}

/** Scheduler means ready but not selected in a batch, not a capacity queue. */
export function runWaiting(
  run: RunRecord,
  settled?: boolean,
): { steps: WaitingStep[]; cleanupPending: boolean } {
  const cleanupPending = settled === false && run.state !== "running";
  if (run.state !== "running") return { steps: [], cleanupPending };
  const done = new Set(
    run.steps
      .filter((step) => step.state === "succeeded")
      .map((step) => step.id),
  );
  const specs = new Map(run.plan.steps.map((step) => [step.id, step]));
  const steps: WaitingStep[] = run.steps
    .filter((step) => step.state === "pending")
    .map((step): WaitingStep => {
      const backoff = backoffs.get(run)?.get(step.id);
      if (backoff)
        return { stepId: step.id, reason: "retry_backoff", ...backoff };
      const spec = specs.get(step.id);
      return {
        stepId: step.id,
        reason:
          !spec || spec.dependsOn.some((id) => !done.has(id))
            ? "dependency"
            : "scheduler",
      };
    });
  return { steps, cleanupPending };
}
