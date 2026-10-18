import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { RunStore } from "./store.js";
import type { RunRecord, StepRecord } from "./store.js";
export interface RunSummary {
    runId: string;
    state: RunRecord["state"];
    goal?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    finishedAt?: number;
    durationMs: number;
    steps: Array<{
        id: string;
        tool: string;
        state: StepRecord["state"];
        attempts: number;
        error?: string;
    }>;
}
/** 每个预设作用域一个运行时服务：运行记录落盘、按会话隔离、可取消/恢复。 */
export declare class RuntimeService {
    private readonly ctx;
    private readonly store;
    private readonly active;
    constructor(ctx: Context, store?: RunStore);
    dispose(): void;
    run(raw: unknown, exec: ToolRunContext, background?: boolean): Promise<RunSummary | {
        runId: string;
        state: "running";
    }>;
    status(raw: unknown, exec: ToolRunContext): RunSummary | {
        runs: {
            updatedAt: number;
            stepCount: number;
            goal?: string | undefined;
            runId: string;
            state: import("./store.js").RunState;
        }[];
    };
    result(raw: unknown, exec: ToolRunContext): {
        results: Record<string, import("./store.js").StoredResult>;
        finished: boolean;
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            error?: string;
        }>;
    };
    cancel(raw: unknown, exec: ToolRunContext): RunSummary;
    resume(raw: unknown, exec: ToolRunContext): Promise<RunSummary>;
    private sessionId;
    private owned;
    private executor;
}
