import type { Plan } from "./plan.js";
import type { RunRecord } from "./store.js";
import type { RunStore } from "./store.js";
export type Invoke = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
/** 按批次 DAG 执行；每次调用前及完成/重试时落盘，存储故障必须停止调度。 */
export declare class RuntimeExecutor {
    private readonly store;
    private readonly invoke;
    private readonly executions;
    constructor(store: RunStore, invoke: Invoke);
    createRun(ownerSessionId: string, plan: Plan, owner?: {
        ownerPid: number;
        ownerProcess: string;
    }): RunRecord;
    execute(run: RunRecord, signal?: AbortSignal): Promise<RunRecord>;
    /** 未知副作用不得重放；出现这种失败时整个恢复运行停止，不启动无关 pending 写。 */
    resume(run: RunRecord, signal?: AbortSignal): Promise<RunRecord>;
    cancel(run: RunRecord, reason?: string): void;
    private terminal;
    private spec;
    private runStep;
    private attempt;
    private now;
    private checkpoint;
}
