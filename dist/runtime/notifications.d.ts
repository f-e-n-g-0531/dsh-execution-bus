export interface NotificationReceipt {
    runId: string;
    key: string;
    revision: number;
    status: "pending" | "delivering" | "sent" | "failed" | "withdrawn";
    attempts: number;
    attemptToken?: string;
    updatedAt: number;
}
/** Durable receipts only. No sending, polling, retrying or DAG execution.
 * The host owns this private directory. Locks left by a crash are deliberately
 * not stolen: the host must reconcile them explicitly while writers are stopped.
 * A delivering receipt is never automatically retried, including after restart.
 */
export declare class NotificationStore {
    private readonly directory;
    constructor(directory: string);
    sync(owner: string, runId: string, key: string, shouldNotify: boolean): NotificationReceipt | undefined;
    get(owner: string, runId: string): NotificationReceipt | undefined;
    claim(owner: string, runId: string, key: string, expectedRevision: number): NotificationReceipt;
    settle(owner: string, runId: string, key: string, expectedRevision: number, attemptToken: string, outcome: "sent" | "failed"): NotificationReceipt;
    private target;
    private checkExpected;
    private expected;
    private locked;
    private read;
    private save;
}
