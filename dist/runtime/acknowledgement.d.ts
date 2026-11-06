import type { RunRecord } from "./store.js";
export interface AcknowledgementRecord {
    revision: number;
    snapshotHash: string;
    key: string;
    reason: string;
    at: number;
}
export declare const MAX_ACKNOWLEDGEMENTS = 32;
/** Bind the execution problem version, not delivery, review, or mutable ledger metadata. */
export declare function attentionSnapshot(run: RunRecord): string | undefined;
/** Strict bounded owner declarations; validity does not prove resolution. */
export declare function validAcknowledgements(value: unknown, createdAt: number): value is AcknowledgementRecord[];
