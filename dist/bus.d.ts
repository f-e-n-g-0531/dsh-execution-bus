import { object, parse } from "./protocol.js";
import type { Capability, Event, Handler, Message, Owner, RecordView, State } from "./protocol.js";
export { object, parse };
export type { Capability, Event, Handler, Message, Owner, RecordView, State };
export interface AdmissionPolicy {
    sessionQueueLimit?: number;
    maxQueueWaitMs?: number;
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
    private entries;
    private handlers;
    private queue;
    private readyOwners;
    private running;
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
    }, admission?: AdmissionPolicy);
    register(name: string, handler: Handler): () => void;
    private key;
    private emit;
    private view;
    private get;
    sweep(now?: number): void;
    submit(owner: Owner, raw: unknown, onEvent?: (e: Event) => void, invoke?: Capability): {
        accepted: Event;
        done: Promise<RecordView>;
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
            phase: string;
            queueMs: number;
            runMs: number;
            remainingQueueMs: number | null;
        }[];
        truncated: boolean;
    };
    private cancel;
    private finish;
    /** 按会话轮转挑选下一个出队项：各会话内部 FIFO，跨会话公平。 */
    private nextQueuedIndex;
    private pump;
    private run;
    close(): Promise<void>;
}
