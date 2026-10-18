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
/** 纯文件持久化运行记录；原子写入，损坏记录忽略，不做跨进程锁。 */
export declare class RunStore {
    readonly root: string;
    constructor(root?: string);
    pathFor(runId: string): string;
    save(run: RunRecord): void;
    load(runId: string): RunRecord | undefined;
    list(limit?: number): RunRecord[];
    remove(runId: string): void;
    prune(max?: number): void;
    /** 启动时把上次进程留下的 running 记录标记为 interrupted；不自动重跑副作用步骤。 */
    markInterrupted(): number;
}
