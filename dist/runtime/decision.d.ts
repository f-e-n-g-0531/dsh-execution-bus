import type { RunRecord } from "./store.js";
import type { RunAttention } from "./attention.js";
export type DecisionDisposition = "answered" | "superseded" | "dismissed";
export interface DecisionRecord {
    revision: number;
    snapshotHash: string;
    key: string;
    disposition: DecisionDisposition;
    reason: string;
    answerRef?: string;
    successorRunId?: string;
    at: number;
}
export interface DecisionInput {
    snapshotHash: string;
    key: string;
    expectedRevision: number;
    disposition: DecisionDisposition;
    reason: string;
    answerRef?: string;
    successorRunId?: string;
}
export declare const MAX_DECISIONS = 32;
export declare function validDecisionText(value: unknown, ref?: boolean): value is string;
export declare function validDecisionInput(value: DecisionInput): boolean;
export declare function validDecisionDispositions(value: unknown, createdAt: number): value is DecisionRecord[];
/** Current declarations only; stale history never closes a new execution snapshot. */
export declare function currentDecision(run: RunRecord, snapshotHash: string | undefined, key: string): DecisionRecord | undefined;
export declare function decisionLedger(run: RunRecord, attention: RunAttention): {
    revision: number;
    verification: "owner_declared_not_user_approval";
    items: {
        recordedAt?: number | undefined;
        status: DecisionDisposition | "open";
        resultHash?: string | undefined;
        stepId?: string | undefined;
        key: string;
    }[];
};
