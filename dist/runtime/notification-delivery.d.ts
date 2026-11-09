import type { NotificationReceipt } from "./notifications.js";
export interface NotificationState {
    runId: string;
    current: {
        key: string;
        shouldNotify: boolean;
    };
    receipt?: NotificationReceipt;
}
/** Host transport only. It must persist/deduplicate messageId before confirming sent.
 * Throws and unknown outcomes may have sent: they must never be automatically retried. */
export type NotificationSender = (message: Readonly<{
    messageId: string;
    runId: string;
    key: string;
    text: string;
}>, signal?: AbortSignal) => Promise<"sent" | "not_sent" | "unknown">;
/** Explicit one-shot host delivery. No timer, polling, background work or DAG access. */
export declare function deliverNotification(protocol: (input: Record<string, unknown>) => NotificationState, readText: () => string, runId: string, sender: NotificationSender, signal?: AbortSignal): Promise<NotificationState>;
