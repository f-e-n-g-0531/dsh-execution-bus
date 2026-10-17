import { performance } from "node:perf_hooks";
import { LIMITS } from "./limits.js";

export type TraceStage =
  | "accepted"
  | "started"
  | "cancel_requested"
  | "terminal"
  | "returned"
  | "job_created"
  | "job_released"
  | "job_error"
  | "reused"
  | "unique_reused";
export interface Trace {
  operation: number;
  stage: TraceStage;
  elapsedMs: number;
}
/** In-memory numeric metadata only: never accepts request/session strings, input, output or error text. */
export class Diagnostics {
  private next = 0;
  private events: (Trace | undefined)[] = new Array(LIMITS.traceRingSize);
  private cursor = 0;
  private size = 0;
  private counts: Partial<Record<TraceStage, number>> = {};
  begin() {
    return { operation: ++this.next, at: performance.now() };
  }
  record(context: { operation: number; at: number }, stage: TraceStage) {
    this.counts[stage] = (this.counts[stage] ?? 0) + 1;
    this.events[this.cursor] = {
      operation: context.operation,
      stage,
      elapsedMs: Math.max(0, performance.now() - context.at),
    };
    this.cursor = (this.cursor + 1) % LIMITS.traceRingSize;
    this.size = Math.min(this.size + 1, LIMITS.traceRingSize);
  }
  snapshot() {
    return {
      counts: { ...this.counts },
      traces: Array.from({ length: this.size }, (_, index) => ({
        ...this.events[
          (this.cursor - this.size + LIMITS.traceRingSize + index) %
            LIMITS.traceRingSize
        ]!,
      })),
    };
  }
}
