export interface AdmissionPolicy {
    sessionQueueLimit?: number;
    maxQueueWaitMs?: number;
}
export type State = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type Owner = {
    sessionId: string;
    callId: string;
};
export type Message = {
    protocolVersion: 1;
    messageId: string;
    requestId: string;
    type: "request" | "status" | "result" | "cancel";
    payload: Record<string, unknown>;
};
export type Event = {
    protocolVersion: 1;
    messageId: string;
    requestId: string;
    correlationId: string;
    sequence: number;
    type: string;
    payload: Record<string, unknown>;
};
export type Capability = (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export interface Handler {
    validate(input: Record<string, unknown>): void;
    run(input: Record<string, unknown>, ctx: {
        signal: AbortSignal;
        progress: (sequence: number, percent: number) => void;
        requestId: string;
        invoke?: Capability;
    }): Promise<unknown>;
}
export interface RecordView {
    requestId: string;
    state: State;
    sequence: number;
    cancelRequested: boolean;
    delivery: "pending" | "returned";
    result?: unknown;
    error?: string;
    progress?: number;
}
export declare function object(v: unknown): Record<string, unknown>;
export declare function parse(raw: unknown): Message;
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
    private pump;
    private run;
    close(): Promise<void>;
}
