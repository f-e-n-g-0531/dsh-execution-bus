import type { Plan } from "./plan.js";
import type { WorkerTrace } from "./agent-trace.js";
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
    createdAt: number;
    updatedAt: number;
    finishedAt?: number;
    error?: string;
}
export declare function defaultRunRoot(): string;
/** Pure file persistence: bounded reads, atomic replacement, no cross-process lock. */
export declare class RunStore {
    readonly root: string;
    private readonly counters;
    constructor(root?: string);
    /** Fixed-size, saturated counters only: never return paths, IDs or record contents. */
    diagnostics(): Readonly<typeof this.counters>;
    private count;
    pathFor(runId: string): string;
    save(run: RunRecord): void;
    load(runId: string): RunRecord | undefined;
    private readRecord;
    private scan;
    list(limit?: number, ownerSessionId?: string, offset?: number): RunRecord[];
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
