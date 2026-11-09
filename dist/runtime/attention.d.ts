import type { RunRecord } from "./store.js";
import type { DecisionDisposition } from "./decision.js";
export type AttentionKind = "inspect_external_state" | "inspect_failure" | "resume_read_only" | "decision_required" | "result_unavailable" | "review_results";
export interface AttentionItem {
    key: string;
    kind: AttentionKind;
    stepId?: string;
    resultHash?: string;
    acknowledged?: true;
    disposition?: DecisionDisposition;
}
export interface RunAttention {
    snapshotHash?: string;
    revision: number;
    items: AttentionItem[];
    notification: {
        key: string;
        shouldNotify: boolean;
    };
}
/**
 * Pure, owner-side advice: Worker decisions are self-reported, never verified.
 * Keys describe content, not delivery, acknowledgement, or cross-session deduplication.
 * No private report text, paths, errors, or plan inputs are projected.
 */
export declare function runAttention(run: RunRecord, settled?: boolean): RunAttention;
