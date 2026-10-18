import type { Plan } from "./plan.js";
import type { RunRecord } from "./store.js";
import type { RunStore } from "./store.js";
export type Invoke = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
/** 按 DAG 执行声明式计划：独立步骤并行、幂等步骤可重试、逐步落盘、可取消/恢复。 */
export declare class RuntimeExecutor {
    private readonly store;
    private readonly invoke;
    constructor(store: RunStore, invoke: Invoke);
    createRun(ownerSessionId: string, plan: Plan): RunRecord;
    execute(run: RunRecord, signal?: AbortSignal): Promise<RunRecord>;
    /** 只恢复 interrupted 运行：幂等步骤重排，副作用步骤保持 unknown/failed。 */
    resume(run: RunRecord, signal?: AbortSignal): Promise<RunRecord>;
    cancel(run: RunRecord, reason?: "RUNTIME_CANCELLED"): void;
    private spec;
    private runStep;
    private touch;
}
