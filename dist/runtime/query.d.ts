import type { RunActionKind } from "./action.js";
import type { RunRecord, RunState } from "./store.js";
export interface QueryInput {
    q?: string;
    taskId?: string;
    state?: RunState;
    action?: RunActionKind;
    view: "all" | "needs_action" | "review";
    limit: number;
    offset: number;
}
export interface QueryResult {
    runs: RunRecord[];
    /** Number after all filters, including view, and before pagination. */
    matchedCount: number;
    /** Exclusive action groups before view filtering and pagination. */
    groups: {
        needsAction: number;
        review: number;
    };
    hasMore: boolean;
}
/** Strict JSON-shaped input: never invoke accessors or coerce values. */
export declare function parseQuery(raw: unknown): QueryInput;
/** Owner-scoped records are supplied by the caller; this function never loads data. */
export declare function queryRuns(runs: RunRecord[], input: QueryInput, settled: (runId: string) => boolean | undefined): QueryResult;
