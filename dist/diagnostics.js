import { performance } from "node:perf_hooks";
/** In-memory numeric metadata only: never accepts request/session strings, input, output or error text. */
export class Diagnostics {
    next = 0;
    events = [];
    counts = {};
    begin() {
        return { operation: ++this.next, at: performance.now() };
    }
    record(context, stage) {
        this.counts[stage] = (this.counts[stage] ?? 0) + 1;
        this.events.push({
            operation: context.operation,
            stage,
            elapsedMs: Math.max(0, performance.now() - context.at),
        });
        if (this.events.length > 128)
            this.events.shift();
    }
    snapshot() {
        return {
            counts: { ...this.counts },
            traces: this.events.map((e) => ({ ...e })),
        };
    }
}
