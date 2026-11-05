/** Structured host hints only: never infer retry safety from human-readable messages. */
export type RetryCategory = "permission" | "invalid" | "not_found" | "transient" | "deterministic" | "legacy_unknown";
export interface RetryClassification {
    category: RetryCategory;
    retryable: boolean;
}
export declare const MAX_RETRIES = 3;
export declare function classifyRetryError(error: unknown): RetryClassification;
/** 1-based retry ordinal, independent of wall clock; at most 700ms total delay. */
export declare function retryDelayMs(retry: number): number;
/** Aborting a backoff clears its timer/listener and never starts a new attempt. */
export declare function waitForRetry(ms: number, signal: AbortSignal): Promise<void>;
