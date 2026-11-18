import { runAcceptance, runRecovery } from "./insights.js";
import type { RunRecord } from "./store.js";
import { ownerReview } from "./review.js";
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
/** Reconstruct the old key only for this exact alert set. Use it to match an
 * existing receipt, never to create a new one or bypass receipt CAS. */
export declare function legacyAcknowledgedNotificationKey(runId: string, attention: RunAttention): string | undefined;
/**
 * Pure, owner-side advice: Worker decisions are self-reported, never verified.
 * Keys describe content, not delivery, acknowledgement, or cross-session deduplication.
 * No private report text, paths, errors, or plan inputs are projected.
 */
export declare function runAttention(run: RunRecord, settled?: boolean, derived?: {
    recovery?: ReturnType<typeof runRecovery>;
    acceptance?: ReturnType<typeof runAcceptance>;
    review?: ReturnType<typeof ownerReview>;
}): RunAttention;
