import type { WorkerReport } from "./agent-report.js";
import type { RunRecord, StepState } from "./store.js";
export interface WorkerAcceptance {
    stepId: string;
    state: StepState;
    resultHash?: string;
    reportOutcome?: WorkerReport["outcome"];
    criteria?: {
        observed: number;
        notVerified: number;
        blocked: number;
    };
    evidenceCount?: number;
    limitationCount?: number;
    decisionRequired?: boolean;
}
export interface RunAcceptance {
    status: "not_reviewed";
    workers: WorkerAcceptance[];
}
/** Worker claims only; never independent verification or an acceptance decision. */
export declare function runAcceptance(run: RunRecord): RunAcceptance;
export interface RunRecovery {
    resultCertainty: "recorded" | "incomplete" | "unknown";
    cleanup: "pending" | "settled" | "unknown";
    externalWork: "unconfirmed";
    nextAction: "wait" | "inspect_external_state" | "resume_read_only" | "review_results" | "inspect_failure";
    message: string;
}
/** Advice only: no storage, execution, retry, cancellation or authorization. */
export declare function runRecovery(run: RunRecord, settled?: boolean): RunRecovery;
