import type { Plan } from "./plan.js";
import type { OwnerReviewRecord } from "./review.js";
import type { WorkerTrace } from "./agent-trace.js";
import type { AcknowledgementRecord } from "./acknowledgement.js";
import type { DecisionInput, DecisionRecord } from "./decision.js";
export type RunState = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type StepState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface StepRecord {
    id: string;
    tool: string;
    state: StepState;
    attempts: number;
    childSessionId?: string;
    workerTrace?: WorkerTrace;
    startedAt?: number;
    finishedAt?: number;
    error?: string;
}
export interface StoredResult {
    value?: unknown;
    truncated?: true;
    bytes?: number;
}
export interface RunRecord {
    version: 1;
    runId: string;
    ownerSessionId: string;
    ownerPid?: number;
    ownerProcess?: string;
    goal?: string;
    plan: Plan;
    state: RunState;
    steps: StepRecord[];
    results: Record<string, StoredResult>;
    ownerReviews?: OwnerReviewRecord[];
    acknowledgements?: AcknowledgementRecord[];
    decisionDispositions?: DecisionRecord[];
    createdAt: number;
    updatedAt: number;
    finishedAt?: number;
    error?: string;
}
export declare function defaultRunRoot(): string;
/** Pure file persistence: bounded reads, atomic replacement, no cross-process lock. */
export declare class RunStore {
    readonly root: string;
    private readonly startedAt;
    private readonly counters;
    constructor(root?: string);
    private readonly lastObservedAt;
    /**
     * Store-instance cumulative, saturated counts and wall-clock observation times.
     * These in-memory observations are not health judgments or persisted history;
     * repeated observations of one record count again. Never expose paths, IDs or text.
     */
    diagnostics(): Readonly<typeof this.counters & {
        startedAt: number;
        observedAt: number;
        lastObservedAt: Readonly<RunStore["lastObservedAt"]>;
    }>;
    private count;
    pathFor(runId: string): string;
    save(run: RunRecord): void;
    /** Review writers serialize across processes; a crash leaves a fail-closed lock. */
    recordReview(runId: string, ownerSessionId: string, input: {
        snapshotHash: string;
        expectedRevision: number;
        disposition: "accepted" | "needs_work";
        reason: string;
    }): RunRecord;
    /** Shares the review/removal lock; only non-recoverable terminal runs may be acknowledged. */
    recordAcknowledgement(runId: string, ownerSessionId: string, input: {
        snapshotHash: string;
        key: string;
        expectedRevision: number;
        reason: string;
    }): RunRecord;
    /** Owner declarations share the review/removal lock and never mutate execution. */
    recordDecision(runId: string, ownerSessionId: string, input: DecisionInput): RunRecord;
    load(runId: string): RunRecord | undefined;
    private readRecord;
    private scan;
    list(limit?: number, ownerSessionId?: string, offset?: number, taskId?: string, strict?: boolean): RunRecord[];
    remove(runId: string): void;
    /** Retain newest max terminal runs; active and recoverable runs never count. */
    prune(max?: number): void;
    private pruneScanned;
    /** One uncached enumeration for scope initialization; mutations still reread. */
    maintain(exclude?: ReadonlySet<string>, max?: number): number;
    /** Recover abandoned running records; legacy records without PID supported. */
    markInterrupted(exclude?: ReadonlySet<string>): number;
    private interruptScanned;
}
