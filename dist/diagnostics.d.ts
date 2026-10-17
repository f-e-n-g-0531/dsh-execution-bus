export type TraceStage = "accepted" | "started" | "cancel_requested" | "terminal" | "returned" | "job_created" | "job_released" | "job_error" | "reused" | "unique_reused";
export interface Trace {
    operation: number;
    stage: TraceStage;
    elapsedMs: number;
}
/** In-memory numeric metadata only: never accepts request/session strings, input, output or error text. */
export declare class Diagnostics {
    private next;
    private events;
    private cursor;
    private size;
    private counts;
    begin(): {
        operation: number;
        at: number;
    };
    record(context: {
        operation: number;
        at: number;
    }, stage: TraceStage): void;
    snapshot(): {
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
            stage: TraceStage;
            elapsedMs: number;
        }[];
    };
}
