/** Minimal structural view of a host session event; no host mutation or retry policy. */
export interface ModelWaitEvent {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data: unknown;
}
export type ModelWaitReason = "budget" | "rate_limit" | "authentication" | "context_limit" | "transient" | "other";
/** Display-only observation, not a retry grant or evidence of model recovery. */
export interface ModelWaitStatus {
    provider: string;
    reason: ModelWaitReason;
    attempts: number;
    since: number;
    lastAt: number;
    nextRetryAt?: number;
}
/**
 * One instance per worker/session. Feed only its ordered host event stream.
 * Observes actual llm/retry events only; rc.1 does not guarantee their emission.
 * Absence of a status is not evidence of provider health or model availability.
 */
export declare class ModelWaitObserver {
    private seq;
    private turn;
    private step;
    private ended;
    private settled;
    private chain?;
    private readonly retired;
    private status?;
    get(): ModelWaitStatus | undefined;
    /** Preserve ordering and seal this step so late events cannot resurrect it. */
    clear(): void;
    private advance;
    observe(event: ModelWaitEvent): void;
}
