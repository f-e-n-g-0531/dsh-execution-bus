import { object, parse } from "./protocol.js";
import type { Capability, Event, Handler, Message, Owner, RecordView, State } from "./protocol.js";
export { object, parse };
export type { Capability, Event, Handler, Message, Owner, RecordView, State };
export interface AdmissionPolicy {
    sessionQueueLimit?: number;
    maxQueueWaitMs?: number;
}
export interface SchedulerPolicy {
    /** Handler.queue → 类别优先级（数值越小越先出队）。 */
    queueClassOrder?: Readonly<Record<string, number>>;
    /** 等待多久提升一级（最多提升两级）。 */
    queueAgingMs?: number;
    /** 运行超过该阈值时在状态快照标记 longRunning。 */
    longRunningMs?: number;
}
/** Volatile single-process bus; no acceptance durability or automatic execution retry. */
export declare class ExecutionBus {
    readonly options: {
        concurrency: number;
        queueLimit: number;
        recordLimit: number;
        resultBytes: number;
        retentionMs: number;
    };
    readonly admission: AdmissionPolicy;
    readonly scheduler: Readonly<Required<SchedulerPolicy>>;
    private entries;
    private handlers;
    private queue;
    private readyOwners;
    private running;
    private runningByHandler;
    /** 资源键 → 占用它的运行中 Entry；有副作用 Handler 据此互斥。 */
    private resourceLocks;
    /** payload 指纹 → 已成功或运行中的 Entry，用于唯一任务复用。 */
    private dedupeIndex;
    private retainedResultBytes;
    private closed;
    private telemetry;
    diagnostics(): {
        phase: "open" | "cancelling" | "draining" | "closed";
        queued: number;
        running: number;
        records: number;
        retainedResultBytes: number;
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
            unique_reused?: number | undefined;
        };
        traces: {
            operation: number;
            stage: import("./diagnostics.js").TraceStage;
            elapsedMs: number;
        }[];
    };
    private closing?;
    private shutdownPhase;
    constructor(options?: {
        concurrency: number;
        queueLimit: number;
        recordLimit: number;
        resultBytes: number;
        retentionMs: number;
    }, admission?: AdmissionPolicy, scheduler?: Readonly<Required<SchedulerPolicy>>);
    register(name: string, handler: Handler): () => void;
    private key;
    private emit;
    private view;
    private get;
    sweep(now?: number): void;
    submit(owner: Owner, raw: unknown, onEvent?: (e: Event) => void, invoke?: Capability): {
        accepted: Event;
        done: Promise<RecordView>;
        /** 本次附着是否复用已有逻辑执行（结果标记可见性用）。 */
        reused: boolean;
        /** 当前快照：供仅在停止等待时使用，不改变交付标记。 */
        snapshot: () => RecordView;
        cancel: () => void;
        detach: () => void;
        returned: () => void;
    };
    /** 校验并拆解 request 的 payload，返回 handler 名、入参与原文。 */
    private requestParts;
    /** 同一 requestId 的重复提交：校验一致性后复用执行或结果。 */
    private reuseInvocation;
    /** 受理全新请求：校验 Handler、检查容量、构建记录并入队。 */
    private admitInvocation;
    /** 若启用了排队期限，登记到期结算为 QUEUE_WAIT_TIMEOUT 的计时器。 */
    private scheduleQueueDeadline;
    /** 计算并校验 Handler 的资源键；失败则请求不进入队列。 */
    private resourcesFor;
    /** 唯一任务命中已成功终态时，构造一个不再执行 Handler 的只读结果记录。 */
    private syntheticUnique;
    private releaseResources;
    /** 是否有空闲槽位供此 Entry 开始执行（Handler 舱壁 + 资源互斥）。 */
    private eligible;
    /** 类别优先级 + 等待老化：分数越低越先出队，长时间等待会逐步压过类别差异。 */
    private effectivePriority;
    /** 对已到期的排队任务结算 QUEUE_WAIT_TIMEOUT，再从队列移除。 */
    private expireQueued;
    private attachment;
    command(owner: Owner, raw: unknown): RecordView;
    private removeQueued;
    /** Trusted host owner required. Never exposes other sessions or business payloads. */
    inspect(owner: Owner): {
        phase: "open" | "cancelling" | "draining" | "closed";
        policy: {
            sessionQueueLimit?: number;
            maxQueueWaitMs?: number;
        };
        counts: {
            queued: number;
            running: number;
            terminal: number;
        };
        tasks: {
            requestId: string;
            state: State;
            delivery: "returned" | "pending";
            cancelRequested: boolean;
            error: string | null;
            progress: number | null;
            waitReason: string | null;
            longRunning: boolean;
            phase: string;
            queueMs: number;
            runMs: number;
            remainingQueueMs: number | null;
        }[];
        truncated: boolean;
    };
    private cancel;
    private finish;
    /** 按会话轮转选择下一个可执行项：会话内按类别优先级 + 老化，跨会话公平。 */
    private nextQueuedIndex;
    private pump;
    private run;
    close(): Promise<void>;
}
