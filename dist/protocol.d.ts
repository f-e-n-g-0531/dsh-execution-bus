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
    /** 是否可安全复用终态结果。省略默认 true（可复用，向后兼容）；
     *  显式 false = 有副作用，终态结果复用将被拒绝（运行中等待仍放行）。 */
    readonly idempotent?: boolean;
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
/** 规范排序后的稳定摘要，只用于同 requestId 的冲突比较，不用于跨请求去重。 */
export declare function canonical(v: unknown): string;
export declare function parse(raw: unknown): Message;
export declare function freezeJson<T>(value: T): T;
