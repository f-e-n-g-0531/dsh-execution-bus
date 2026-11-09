import type { RunRecord } from "./store.js";
import type { PlanStep } from "./plan.js";
export interface DependencyPage {
    ref: string;
    hash: string;
    offset: number;
    total: number;
    text: string;
    nextOffset?: number;
}
export interface DependencyContext {
    readonly ownerSessionId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly previews: ReadonlyArray<{
        id: string;
        ref: string;
        hash: string;
        total: number;
        preview: string;
    }>;
    read(input: unknown): DependencyPage;
}
/** Invocation-scoped capability; references confer no authority outside this closure. */
export declare function dependencyContext(run: RunRecord, spec: PlanStep, signal: AbortSignal): DependencyContext;
