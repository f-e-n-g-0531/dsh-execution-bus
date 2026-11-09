import type { RunRecord } from "./store.js";
export interface HandoffSelection {
    stepId: string;
    resultHash: string;
}
export interface HandoffSnapshot {
    kind: "untrusted_run_handoff";
    sourceRunId: string;
    taskId: string;
    summary: string;
    selections: HandoffSelection[];
    snapshotHash: string;
    authorized: false;
    executable: false;
}
export interface HandoffInput {
    runId: string;
    selections: HandoffSelection[];
    summary: string;
}
export declare function parseHandoffInput(raw: unknown): HandoffInput;
/** Pure structural/integrity validation; the service must separately revalidate the source. */
export declare function parseHandoffSnapshot(raw: unknown): HandoffSnapshot;
/** No result payload escapes this function; no authority or execution is conveyed. */
export declare function createHandoffSnapshot(input: HandoffInput, source: RunRecord): HandoffSnapshot;
export declare function verifyHandoffSelections(items: HandoffSelection[], source: RunRecord): void;
