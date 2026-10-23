import type { Plan } from "./plan.js";
export type RunState = "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
export type StepState = "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface StepRecord {
    id: string;
    tool: string;
    state: StepState;
    attempts: number;
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
    private scan;
    list(limit?: number, ownerSessionId?: string, offset?: number): RunRecord[];
    remove(runId: string): void;
    /** Retain the newest max terminal runs; active and recoverable runs never count toward the budget. */
    prune(max?: number): void;
    /** Recover only abandoned running records; legacy records without a PID remain supported. */
    markInterrupted(exclude?: ReadonlySet<string>): number;
}
