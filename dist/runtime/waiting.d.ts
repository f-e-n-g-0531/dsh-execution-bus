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
    /** Derived display only: a transient read may retry; it is not a new retry grant. */
    disposition?: "waiting_retry" | "needs_action";
}
export declare function setRetryBackoff(run: RunRecord, stepId: string, metadata: RetryBackoff): void;
export declare function clearRetryBackoff(run: RunRecord, stepId: string): void;
/** Scheduler means ready but not selected in a batch, not a capacity queue. */
export declare function runWaiting(run: RunRecord, settled?: boolean): {
    steps: WaitingStep[];
    cleanupPending: boolean;
};
