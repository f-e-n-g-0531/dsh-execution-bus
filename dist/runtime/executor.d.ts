import type { DependencyContext } from "./dependency-context.js";
import type { Plan } from "./plan.js";
import type { RunRecord } from "./store.js";
import type { RunStore } from "./store.js";
import type { WorkerTrace } from "./agent-trace.js";
export type Invoke = (tool: string, input: Record<string, unknown>, signal: AbortSignal, onCreated?: (sessionId: string, trace?: WorkerTrace) => void, context?: DependencyContext) => Promise<unknown>;
/** 纯只读 DAG 完成即补槽，其余保留批次执行；调用前及完成/重试时落盘。 */
export declare class RuntimeExecutor {
    private readonly store;
    private readonly invoke;
    private readonly dependencyTool?;
    private readonly executions;
    constructor(store: RunStore, invoke: Invoke, dependencyTool?: string | undefined);
    createRun(ownerSessionId: string, plan: Plan, owner?: {
        ownerPid: number;
        ownerProcess: string;
    }): RunRecord;
    execute(run: RunRecord, signal?: AbortSignal): Promise<RunRecord>;
    /** 未知副作用不得重放；出现这种失败时整个恢复运行停止，不启动无关 pending 写。 */
    resume(run: RunRecord, signal?: AbortSignal): Promise<RunRecord>;
    cancel(run: RunRecord, reason?: string): void;
    /** Retry backoff retains its slot; timeout/failure stops new dispatch. */
    private executeReadOnly;
    private terminal;
    private spec;
    private runStep;
    private stepInput;
    private attempt;
    private now;
    private checkpoint;
}
