import type { JobRegistry, JobId } from "@deepseek-ai/dsh-jobs";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { RecordView, Event } from "./bus.js";
import { Diagnostics } from "./diagnostics.js";
export interface ExecutionAttachment {
    done: Promise<RecordView>;
    cancel(): void;
}
/** One host projection of a logical execution. The core completion remains authoritative. */
export declare class ExecutionHandle {
    private jobs;
    private owner;
    private execution;
    private telemetry;
    readonly completion: Promise<RecordView>;
    readonly settled: Promise<void>;
    readonly job: JobId;
    private progressHandle?;
    private trace;
    constructor(jobs: JobRegistry, owner: SessionId, execution: ExecutionAttachment, telemetry?: Diagnostics);
    requestCancel(): void;
    progress(event: Event): void;
    private absent;
    private waitAndClean;
    /** 等待宿主 Job 到达终态（离开 running/stopping）。 */
    private awaitTerminal;
    /** wait 失败后的有界恢复：清理已终态的 Job，但仍向上保留原始错误可见性。 */
    private recoverOnWaitError;
}
export type ShutdownPhase = "open" | "stopping" | "draining" | "releasing" | "closed";
/** Owns host projections and active deliveries, not a second execution state machine. */
export declare class ExecutionOwner {
    private handles;
    private deliveries;
    private closing?;
    private telemetry;
    create(key: string, jobs: JobRegistry, owner: SessionId, execution: ExecutionAttachment): ExecutionHandle;
    diagnostics(): {
        phase: ShutdownPhase;
        activeProjections: number;
        deliveries: number;
        counts: {
            accepted?: number | undefined;
            started?: number | undefined;
            cancel_requested?: number | undefined;
            terminal?: number | undefined;
            returned?: number | undefined;
            job_created?: number | undefined;
            job_released?: number | undefined;
            job_error?: number | undefined;
            reused?: number | undefined;
        };
        traces: {
            operation: number;
            stage: import("./diagnostics.js").TraceStage;
            elapsedMs: number;
        }[];
    };
    private currentPhase;
    get phase(): ShutdownPhase;
    get(key: string): ExecutionHandle | undefined;
    add(key: string, handle: ExecutionHandle): void;
    /** 拒绝关闭后或重复 key 的准入；create/add 共用这一道守卫。 */
    private assertAdmittable;
    /** 登记 handle，并在其结算后从表中移除该登记。 */
    private attach;
    track<T>(delivery: Promise<T>): Promise<T>;
    close(drainCore: () => Promise<void>): Promise<void>;
}
