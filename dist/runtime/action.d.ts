import type { RunRecord } from "./store.js";
export type RunActionKind = "inspect_external_state" | "wait_cleanup" | "inspect_failure" | "decision_required" | "result_unavailable" | "resume_read_only" | "review_results" | "wait_retry" | "working" | "settled";
export interface RunAction {
    kind: RunActionKind;
    actor: "owner" | "runtime" | "none";
    message: string;
}
/**
 * Display-only next action, derived from current observations. No storage,
 * execution, acknowledgement, retry grant, or private payload is returned.
 */
export declare function runAction(run: RunRecord, settled?: boolean): RunAction;
