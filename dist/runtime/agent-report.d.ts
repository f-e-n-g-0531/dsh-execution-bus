export interface AcceptanceCriterion {
    id: string;
    description: string;
}
export interface WorkerReportCriterion {
    id: string;
    status: "observed" | "not_verified" | "blocked";
    evidence_indices: number[];
    note: string;
}
export declare function parseAcceptanceCriteria(raw: unknown): AcceptanceCriterion[];
export declare function workerCriteriaInstructions(criteria: AcceptanceCriterion[]): string;
export interface WorkerReportEvidence {
    path: string;
    lineStart?: number;
    lineEnd?: number;
    revision?: string;
}
/** Worker claims only: parsing neither reads evidence nor independently verifies it. */
export interface WorkerReport {
    outcome: "completed" | "partial" | "blocked";
    summary: string;
    evidence: WorkerReportEvidence[];
    limitations: string[];
    requestedDecision?: string;
    criteria?: WorkerReportCriterion[];
}
export declare const WORKER_REPORT_INSTRUCTIONS: string;
/** Strict wire validation only; evidence paths are intentionally not resolved or opened. */
export declare function parseWorkerReport(output: string, criteria?: AcceptanceCriterion[]): WorkerReport;
