/** One synchronous admission budget for all Worker lifetimes under a run root. */
export class WorkerQuota {
  private active = 0;

  constructor(private readonly limit = 8) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError("Invalid Worker quota");
  }

  /** Includes creation, execution, and awaited cleanup; not just running turns. */
  get activeCount(): number {
    return this.active;
  }

  reserve(): () => void {
    if (this.active >= this.limit)
      throw Error("RUNTIME_AGENT_CAPACITY_EXCEEDED");
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
    };
  }
}
