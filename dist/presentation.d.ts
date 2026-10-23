import type { JsonSchemaNode, ToolResult, ToolResultView } from "@deepseek-ai/dsh-tools";
import type { RunRecord } from "./runtime/store.js";
export interface RunProgress {
    total: number;
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    unknown: number;
}
export interface RunGuidance {
    code: string;
    message: string;
    stepId?: string;
    jobId?: string;
    suggestions?: Array<{
        tool: string;
        input: Record<string, string>;
    }>;
}
/** Derived only after the service selected an owned record; never persisted. */
export declare function runProgress(run: RunRecord): RunProgress;
/** Advice is not an execution policy, authorization, or proof a Job stopped. */
export declare function runGuidance(run: RunRecord): RunGuidance[];
/** Host-supported subset: dynamic step result keys/values deliberately remain JSON. */
export declare const RUNTIME_OUTPUT_SCHEMAS: Record<string, JsonSchemaNode>;
/** Replayable metadata excludes inputs, raw result values and owner identity. */
export declare function runtimePresentationMeta(_args: unknown, value: unknown): {
    title: string;
    text: string;
};
export declare function presentRuntimeResult(_args: unknown, result: ToolResult): ToolResultView | undefined;
