/** One synchronous admission budget for all Worker lifetimes under a run root. */
export declare class WorkerQuota {
    private readonly limit;
    private active;
    constructor(limit?: number);
    /** Includes creation, execution, and awaited cleanup; not just running turns. */
    get activeCount(): number;
    reserve(): () => void;
}
