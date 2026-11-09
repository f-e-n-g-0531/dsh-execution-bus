import { createHash } from "node:crypto";
import type { NotificationReceipt } from "./notifications.js";

export interface NotificationState {
  runId: string;
  current: { key: string; shouldNotify: boolean };
  receipt?: NotificationReceipt;
}

/** Host transport only. It must persist/deduplicate messageId before confirming sent.
 * Throws and unknown outcomes may have sent: they must never be automatically retried. */
export type NotificationSender = (
  message: Readonly<{
    messageId: string;
    runId: string;
    key: string;
    text: string;
  }>,
  signal?: AbortSignal,
) => Promise<"sent" | "not_sent" | "unknown">;

/** Explicit one-shot host delivery. No timer, polling, background work or DAG access. */
export async function deliverNotification(
  protocol: (input: Record<string, unknown>) => NotificationState,
  readText: () => string,
  runId: string,
  sender: NotificationSender,
  signal?: AbortSignal,
): Promise<NotificationState> {
  signal?.throwIfAborted();
  const state = protocol({ runId, operation: "sync" });
  const receipt = state.receipt;
  // Failed attempts require explicit reconciliation through the receipt protocol,
  // not a repeated call to this helper. Delivering can mean sent before a crash.
  if (!state.current.shouldNotify || receipt?.status !== "pending")
    return state;
  const text = readText();
  signal?.throwIfAborted();
  const claimed = protocol({
    runId,
    operation: "claim",
    key: state.current.key,
    expectedRevision: receipt.revision,
  });
  const attempt = claimed.receipt!;
  const messageId =
    "xiao-he-notification:" +
    createHash("sha256")
      .update(JSON.stringify([runId, attempt.key]))
      .digest("hex");
  // Recheck after claiming. A new snapshot cannot be sent using the old claim.
  const current = protocol({ runId, operation: "sync" });
  if (
    current.receipt?.revision !== attempt.revision ||
    current.receipt?.attemptToken !== attempt.attemptToken ||
    !current.current.shouldNotify
  )
    return current;
  signal?.throwIfAborted();
  let outcome: "sent" | "not_sent" | "unknown";
  try {
    outcome = await sender(
      Object.freeze({ messageId, runId, key: attempt.key, text }),
      signal,
    );
  } catch {
    // Do not expose transport errors, credentials or recipient details.
    return protocol({ runId, operation: "get" });
  }
  if (outcome !== "sent" && outcome !== "not_sent")
    return protocol({ runId, operation: "get" });
  // Cancellation or storage failure after send leaves an uncertain delivering
  // receipt. A stale callback is rejected by the existing CAS protocol.
  signal?.throwIfAborted();
  return protocol({
    runId,
    operation: "settle",
    key: attempt.key,
    expectedRevision: attempt.revision,
    attemptToken: attempt.attemptToken,
    outcome: outcome === "sent" ? "sent" : "failed",
  });
}
