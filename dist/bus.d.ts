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
    private entries;
    private handlers;
    private queue;
    private running;
    private closed;
    constructor(options?: {
        concurrency: number;
        queueLimit: number;
        recordLimit: number;
        resultBytes: number;
        retentionMs: number;
    });
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
    private cancel;
    private finish;
    private pump;
    private run;
    close(): Promise<void>;
}
