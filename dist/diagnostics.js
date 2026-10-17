import { performance } from "node:perf_hooks";
import { LIMITS } from "./limits.js";
/** In-memory numeric metadata only: never accepts request/session strings, input, output or error text. */
export class Diagnostics {
    next = 0;
    events = new Array(LIMITS.traceRingSize);
    cursor = 0;
    size = 0;
    counts = {};
    begin() {
        return { operation: ++this.next, at: performance.now() };
    }
    record(context, stage) {
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
                ...this.events[(this.cursor - this.size + LIMITS.traceRingSize + index) %
                    LIMITS.traceRingSize],
            })),
        };
    }
}
