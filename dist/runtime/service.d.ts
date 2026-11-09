import { runAction } from "./action.js";
import type { PlanChanges } from "./plan-diff.js";
import type { NotificationSender } from "./notification-delivery.js";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { RunProgress, RunGuidance } from "../presentation.js";
import type { RunAttention } from "./attention.js";
import { runWaiting } from "./waiting.js";
import { ownerReview } from "./review.js";
import { decisionLedger } from "./decision.js";
import type { RunRecovery } from "./insights.js";
import type { DelegationPolicyAdapter, WorkerHostOptions } from "./agent.js";
import type { Plan } from "./plan.js";
import { RunStore } from "./store.js";
import type { RunRecord, StepRecord } from "./store.js";
type RunWaiting = ReturnType<typeof runWaiting>;
export type PlanComparison = {
    comparable: true;
    changes: PlanChanges;
} | {
    comparable: false;
    reason: "no_previous_run" | "predecessor_unavailable" | "incompatible_predecessor";
};
/** Trusted host observation only; never registered as a model tool or a reservation. */
export interface CapacitySnapshot {
    scope: "module_process_root";
    observedAt: number;
    occupiedRuns: number;
    executingRuns: number;
    cleanupRuns: number;
    runLimit: number;
    workersInUse: number;
    workerLimit: number;
}
export interface RunSummary {
    runId: string;
    state: RunRecord["state"];
    goal?: string;
    provenance?: Plan["provenance"];
    taskId?: string;
    previousRunId?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    finishedAt?: number;
    durationMs: number;
    executionSettled?: boolean;
    progress: RunProgress;
    guidance: RunGuidance[];
    recovery: RunRecovery;
    attention: RunAttention;
    decisionLedger: ReturnType<typeof decisionLedger>;
    waiting: RunWaiting;
    ownerReview: ReturnType<typeof ownerReview>;
    action: ReturnType<typeof runAction>;
    steps: Array<{
        id: string;
        tool: string;
        state: StepRecord["state"];
        attempts: number;
        childSessionId?: string;
        workerTrace?: StepRecord["workerTrace"];
        error?: string;
    }>;
}
/** Scope facade over a process-wide, root-keyed execution owner. */
export declare class RuntimeService {
    private readonly ctx;
    private readonly delegationPolicy?;
    private readonly workerHostOptions?;
    private readonly history;
    private readonly store;
    private readonly notifications;
    private readonly key;
    private readonly manager;
    private closed;
    private disposal?;
    constructor(ctx: Context, store?: RunStore, delegationPolicy?: DelegationPolicyAdapter | undefined, workerHostOptions?: WorkerHostOptions | undefined);
    dispose(): Promise<void>;
    /** Host-only aggregate of this module/process and canonical root. No paths, IDs or IO.
     * Executing includes admitted resume initialization (still interrupted).
     * Cleanup means a terminal run whose owned execution has not settled; it is not
     * proof that ordinary host calls or background Jobs have exited. */
    capacity(): CapacitySnapshot;
    /** Descriptive only: no policy checks, tool dispatch, capacity reservation or run creation. */
    capabilities(raw: unknown, exec: ToolRunContext): {
        ordinaryDag: "supported";
        worker: "unavailable" | "conditional";
        workerReason: "trusted_adapter_missing" | "parent_admission_missing" | "execution_checks_required";
        ordinaryAsync: boolean;
        workerAsync: false;
        workerTools: string[];
        limits: {
            maxSteps: 32;
            maxConcurrency: 4;
            maxActiveRuns: number;
            maxWorkers: number;
        };
        capacity: {
            scope: "module_process_root";
            observedAt: number;
            capacityBusy: boolean;
        };
        authorization: "checked_at_execution";
        message: string;
    };
    run(raw: unknown, exec: ToolRunContext, background?: boolean): Promise<RunSummary | {
        runId: string;
        state: "running";
    }>;
    /** Owner-scoped metadata search. Never dispatches tools or indexes payload text. */
    query(raw: unknown, exec: ToolRunContext): {
        kind: "owner_metadata_query";
        runs: {
            updatedAt: number;
            stepCount: number;
            action: import("./action.js").RunAction;
            previousRunId?: string | undefined;
            taskId?: string | undefined;
            provenance?: import("./plan.js").PlanProvenance | undefined;
            goal?: string | undefined;
            runId: string;
            state: import("./store.js").RunState;
        }[];
        view: "all" | "needs_action" | "review";
        offset: number;
        limit: number;
        matchedCount: number;
        groups: {
            needsAction: number;
            review: number;
        };
        hasMore: boolean;
        scope: "retained_owner_runs";
        order: "updatedAt_desc_runId_asc";
        observedAt: number;
        scannedCount: number;
        scanLimit: number;
        diagnostics: Readonly<{
            invalidRecords: number;
            oversizedRecords: number;
            readFailures: number;
            writeFailures: number;
        } & {
            startedAt: number;
            observedAt: number;
            lastObservedAt: Readonly<RunStore["lastObservedAt"]>;
        }>;
        message: string;
    };
    status(raw: unknown, exec: ToolRunContext): RunSummary | {
        runs: RunSummary[];
        offset: number;
        limit: number;
        hasMore: boolean;
        scope: "retained_owner_runs";
        order: "snapshot_membership";
        pagination: {
            nextCursor?: string | undefined;
            mode: "snapshot";
            capturedAt: number;
            expiresAt: number;
            total: number;
            missingRunIds: string[];
        };
        page: {
            runCount: number;
            activeCount: number;
            attentionCount: number;
            reviewCount: number;
        };
        diagnostics: Readonly<{
            invalidRecords: number;
            oversizedRecords: number;
            readFailures: number;
            writeFailures: number;
        } & {
            startedAt: number;
            observedAt: number;
            lastObservedAt: Readonly<RunStore["lastObservedAt"]>;
        }>;
        message: string;
        taskId?: string | undefined;
    } | {
        runs: {
            updatedAt: number;
            stepCount: number;
            progress: RunProgress;
            guidance: RunGuidance[];
            attention: RunAttention;
            decisionLedger: {
                revision: number;
                verification: "owner_declared_not_user_approval";
                items: {
                    recordedAt?: number | undefined;
                    status: import("./decision.js").DecisionDisposition | "open";
                    resultHash?: string | undefined;
                    stepId?: string | undefined;
                    key: string;
                }[];
            };
            waiting: {
                steps: import("./waiting.js").WaitingStep[];
                cleanupPending: boolean;
            };
            ownerReview: {
                recordedAt?: number | undefined;
                snapshotHash?: string | undefined;
                revision: number;
                status: "accepted" | "needs_work" | "stale" | "not_recorded";
                verification: "owner_declared_not_independently_verified";
            };
            action: import("./action.js").RunAction;
            error?: string | undefined;
            previousRunId?: string | undefined;
            taskId?: string | undefined;
            provenance?: import("./plan.js").PlanProvenance | undefined;
            goal?: string | undefined;
            runId: string;
            state: import("./store.js").RunState;
        }[];
        diagnostics: Readonly<{
            invalidRecords: number;
            oversizedRecords: number;
            readFailures: number;
            writeFailures: number;
        } & {
            startedAt: number;
            observedAt: number;
            lastObservedAt: Readonly<RunStore["lastObservedAt"]>;
        }>;
    };
    /** Read-only task page over retained owned records; never a claim of complete history. */
    task(raw: unknown, exec: ToolRunContext): {
        runs: RunSummary[];
        offset: number;
        limit: number;
        hasMore: boolean;
        scope: "retained_owner_runs";
        order: "snapshot_membership";
        pagination: {
            nextCursor?: string | undefined;
            mode: "snapshot";
            capturedAt: number;
            expiresAt: number;
            total: number;
            missingRunIds: string[];
        };
        page: {
            runCount: number;
            activeCount: number;
            attentionCount: number;
            reviewCount: number;
        };
        diagnostics: Readonly<{
            invalidRecords: number;
            oversizedRecords: number;
            readFailures: number;
            writeFailures: number;
        } & {
            startedAt: number;
            observedAt: number;
            lastObservedAt: Readonly<RunStore["lastObservedAt"]>;
        }>;
        message: string;
        taskId?: string | undefined;
    } | {
        taskId: string;
        runs: RunSummary[];
        offset: number;
        limit: number;
        hasMore: boolean;
        scope: "retained_owner_runs";
        order: "updatedAt_desc_runId_asc";
        page: {
            runCount: number;
            activeCount: number;
            attentionCount: number;
            reviewCount: number;
        };
        diagnostics: Readonly<{
            invalidRecords: number;
            oversizedRecords: number;
            readFailures: number;
            writeFailures: number;
        } & {
            startedAt: number;
            observedAt: number;
            lastObservedAt: Readonly<RunStore["lastObservedAt"]>;
        }>;
        message: string;
    };
    /** Freeze membership/order only. Re-read each owned record so actions never use stale state. */
    private historyPage;
    /** Host-only, explicit delivery using the original owner's context. Not a model tool. */
    deliverNotification(runId: string, exec: ToolRunContext, sender: NotificationSender): Promise<import("./notification-delivery.js").NotificationState>;
    /** Explicit receipt protocol only. No sender, timer, replay, or DAG invocation. */
    notification(raw: unknown, exec: ToolRunContext): {
        verification: "owner_declared_not_delivery_verified";
        message: string;
        receipt?: import("./notifications.js").NotificationReceipt | undefined;
        runId: string;
        current: {
            key: string;
            shouldNotify: boolean;
        };
    };
    acknowledge(raw: unknown, exec: ToolRunContext): {
        acknowledgementHistory: import("./acknowledgement.js").AcknowledgementRecord[];
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        provenance?: Plan["provenance"];
        taskId?: string;
        previousRunId?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        executionSettled?: boolean;
        progress: RunProgress;
        guidance: RunGuidance[];
        recovery: RunRecovery;
        attention: RunAttention;
        decisionLedger: ReturnType<typeof decisionLedger>;
        waiting: RunWaiting;
        ownerReview: ReturnType<typeof ownerReview>;
        action: ReturnType<typeof runAction>;
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            childSessionId?: string;
            workerTrace?: StepRecord["workerTrace"];
            error?: string;
        }>;
    };
    decision(raw: unknown, exec: ToolRunContext): {
        decisionHistory: import("./decision.js").DecisionRecord[];
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        provenance?: Plan["provenance"];
        taskId?: string;
        previousRunId?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        executionSettled?: boolean;
        progress: RunProgress;
        guidance: RunGuidance[];
        recovery: RunRecovery;
        attention: RunAttention;
        decisionLedger: ReturnType<typeof decisionLedger>;
        waiting: RunWaiting;
        ownerReview: ReturnType<typeof ownerReview>;
        action: ReturnType<typeof runAction>;
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            childSessionId?: string;
            workerTrace?: StepRecord["workerTrace"];
            error?: string;
        }>;
    };
    review(raw: unknown, exec: ToolRunContext): {
        ownerReviewHistory: import("./review.js").OwnerReviewRecord[];
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        provenance?: Plan["provenance"];
        taskId?: string;
        previousRunId?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        executionSettled?: boolean;
        progress: RunProgress;
        guidance: RunGuidance[];
        recovery: RunRecovery;
        attention: RunAttention;
        decisionLedger: ReturnType<typeof decisionLedger>;
        waiting: RunWaiting;
        ownerReview: ReturnType<typeof ownerReview>;
        action: ReturnType<typeof runAction>;
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            childSessionId?: string;
            workerTrace?: StepRecord["workerTrace"];
            error?: string;
        }>;
    };
    result(raw: unknown, exec: ToolRunContext): {
        acceptance: import("./insights.js").RunAcceptance;
        ownerReviewHistory: import("./review.js").OwnerReviewRecord[];
        acknowledgementHistory: import("./acknowledgement.js").AcknowledgementRecord[];
        decisionHistory: import("./decision.js").DecisionRecord[];
        results: {};
        finished: boolean;
        page: {
            nextOffset?: number | undefined;
            stepId: string;
            encoding: string;
            unit: string;
            hash: string;
            offset: number;
            total: number;
            text: string;
        };
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        provenance?: Plan["provenance"];
        taskId?: string;
        previousRunId?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        executionSettled?: boolean;
        progress: RunProgress;
        guidance: RunGuidance[];
        recovery: RunRecovery;
        attention: RunAttention;
        decisionLedger: ReturnType<typeof decisionLedger>;
        waiting: RunWaiting;
        ownerReview: ReturnType<typeof ownerReview>;
        action: ReturnType<typeof runAction>;
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            childSessionId?: string;
            workerTrace?: StepRecord["workerTrace"];
            error?: string;
        }>;
    } | {
        planComparison: PlanComparison;
        results: Record<string, import("./store.js").StoredResult>;
        finished: boolean;
        handoff?: import("./handoff.js").HandoffSnapshot | undefined;
        acceptance: import("./insights.js").RunAcceptance;
        ownerReviewHistory: import("./review.js").OwnerReviewRecord[];
        acknowledgementHistory: import("./acknowledgement.js").AcknowledgementRecord[];
        decisionHistory: import("./decision.js").DecisionRecord[];
        runId: string;
        state: RunRecord["state"];
        goal?: string;
        provenance?: Plan["provenance"];
        taskId?: string;
        previousRunId?: string;
        error?: string;
        createdAt: number;
        updatedAt: number;
        finishedAt?: number;
        durationMs: number;
        executionSettled?: boolean;
        progress: RunProgress;
        guidance: RunGuidance[];
        recovery: RunRecovery;
        attention: RunAttention;
        decisionLedger: ReturnType<typeof decisionLedger>;
        waiting: RunWaiting;
        ownerReview: ReturnType<typeof ownerReview>;
        action: ReturnType<typeof runAction>;
        steps: Array<{
            id: string;
            tool: string;
            state: StepRecord["state"];
            attempts: number;
            childSessionId?: string;
            workerTrace?: StepRecord["workerTrace"];
            error?: string;
        }>;
    };
    cancel(raw: unknown, exec: ToolRunContext): RunSummary;
    resume(raw: unknown, exec: ToolRunContext): Promise<RunSummary>;
    private start;
    private rememberStorageFailure;
    private releaseManager;
    private ensureOpen;
    private admit;
    private sessionId;
    /** Full result detail only: no list fan-out, checkpoints, result reuse or authority. */
    private comparePredecessor;
    /** Produce only an owner-authored untrusted snapshot; persistence is in a later plan. */
    handoff(raw: unknown, exec: ToolRunContext): import("./handoff.js").HandoffSnapshot;
    private handoffSource;
    private validateHandoff;
    private owned;
    private executor;
}
export {};
