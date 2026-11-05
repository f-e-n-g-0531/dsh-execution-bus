import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { RunProgress, RunGuidance } from "../presentation.js";
import type { DelegationPolicyAdapter } from "./agent.js";
import { RunStore } from "./store.js";
import type { RunRecord, StepRecord } from "./store.js";
export interface RunSummary {
    runId: string;
    state: RunRecord["state"];
    goal?: string;
    taskId?: string;
    previousRunId?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    finishedAt?: number;
    durationMs: number;
    executionSettled?: boolean;
    progress: RunProgress;
    guidance: RunGuidance[];
    steps: Array<{
        id: string;
        tool: string;
        state: StepRecord["state"];
        attempts: number;
        childSessionId?: string;
        workerTrace?: StepRecord["workerTrace"];
        error?: string;
    }>;
}
/** Scope facade over a process-wide, root-keyed execution owner. */
export declare class RuntimeService {
    private readonly ctx;
    private readonly delegationPolicy?;
    private readonly store;
    private readonly key;
    private readonly manager;
    private closed;
    private disposal?;
    constructor(ctx: Context, store?: RunStore, delegationPolicy?: DelegationPolicyAdapter | undefined);
    dispose(): Promise<void>;
    run(raw: unknown, exec: ToolRunContext, background?: boolean): Promise<RunSummary | {
        runId: string;
        state: "running";
    }>;
    status(raw: unknown, exec: ToolRunContext): RunSummary | {
        runs: {
            updatedAt: number;
            stepCount: number;
            progress: RunProgress;
            guidance: RunGuidance[];
            error?: string | undefined;
            previousRunId?: string | undefined;
            taskId?: string | undefined;
            goal?: string | undefined;
            runId: string;
            state: import("./store.js").RunState;
        }[];
        diagnostics: Readonly<{
            invalidRecords: number;
            oversizedRecords: number;
            readFailures: number;
            writeFailures: number;
        }>;
    };
    result(raw: unknown, exec: ToolRunContext): {
        results: {};
        finished: boolean;
        page: {
            nextOffset?: number | undefined;
            stepId: string;
            encoding: string;
            unit: string;
            hash: string;
            offset: number;
            total: number;
            text: string;
        };
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        taskId?: string;
        previousRunId?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        executionSettled?: boolean;
        progress: RunProgress;
        guidance: RunGuidance[];
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            childSessionId?: string;
            workerTrace?: StepRecord["workerTrace"];
            error?: string;
        }>;
    } | {
        results: Record<string, import("./store.js").StoredResult>;
        finished: boolean;
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        taskId?: string;
        previousRunId?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        executionSettled?: boolean;
        progress: RunProgress;
        guidance: RunGuidance[];
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            childSessionId?: string;
            workerTrace?: StepRecord["workerTrace"];
            error?: string;
        }>;
    };
    cancel(raw: unknown, exec: ToolRunContext): RunSummary;
    resume(raw: unknown, exec: ToolRunContext): Promise<RunSummary>;
    private start;
    private rememberStorageFailure;
    private releaseManager;
    private ensureOpen;
    private admit;
    private sessionId;
    private owned;
    private executor;
}
