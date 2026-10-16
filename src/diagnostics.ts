import { performance } from "node:perf_hooks";
export type TraceStage =
  | "accepted"
  | "started"
  | "cancel_requested"
  | "terminal"
  | "returned"
  | "job_created"
  | "job_released"
  | "job_error"
  | "reused";
export interface Trace {
  operation: number;
  stage: TraceStage;
  elapsedMs: number;
}
/** In-memory numeric metadata only: never accepts request/session strings, input, output or error text. */
export class Diagnostics {
  private next = 0;
  private events: Trace[] = [];
  private counts: Partial<Record<TraceStage, number>> = {};
  begin() {
    return { operation: ++this.next, at: performance.now() };
  }
  record(context: { operation: number; at: number }, stage: TraceStage) {
    this.counts[stage] = (this.counts[stage] ?? 0) + 1;
    this.events.push({
      operation: context.operation,
      stage,
      elapsedMs: Math.max(0, performance.now() - context.at),
    });
    if (this.events.length > 128) this.events.shift();
  }
  snapshot() {
    return {
      counts: { ...this.counts },
      traces: this.events.map((e) => ({ ...e })),
    };
  }
}
