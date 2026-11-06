import { ERRORS } from "../error-codes.js";
/** One synchronous admission budget for all Worker lifetimes under a run root. */
export class WorkerQuota {
    limit;
    active = 0;
    constructor(limit = 8) {
        this.limit = limit;
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new RangeError("Invalid Worker quota");
    }
    /** Includes creation, execution, and awaited cleanup; not just running turns. */
    get activeCount() {
        return this.active;
    }
    reserve() {
        if (this.active >= this.limit)
            throw Error(ERRORS.RUNTIME_AGENT_CAPACITY_EXCEEDED);
        this.active++;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.active--;
        };
    }
}
