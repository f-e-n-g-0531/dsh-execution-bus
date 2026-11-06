import { createHash } from "node:crypto";
import { runAcceptance, runRecovery } from "./insights.js";
import type { RunRecord } from "./store.js";
import { ownerReview } from "./review.js";
import { attentionSnapshot } from "./acknowledgement.js";

export type AttentionKind =
  | "inspect_external_state"
  | "inspect_failure"
  | "resume_read_only"
  | "decision_required"
  | "result_unavailable"
  | "review_results";

export interface AttentionItem {
  key: string;
  kind: AttentionKind;
  stepId?: string;
  resultHash?: string;
  acknowledged?: true;
}

export interface RunAttention {
  snapshotHash?: string;
  revision: number;
  items: AttentionItem[];
  notification: { key: string; shouldNotify: boolean };
}

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Review stays visible, but a successful result is not an interrupt by itself. */
const NOTIFY_KINDS = new Set<AttentionKind>([
  "inspect_external_state",
  "inspect_failure",
  "resume_read_only",
  "decision_required",
  "result_unavailable",
]);

/**
 * Pure, owner-side advice: Worker decisions are self-reported, never verified.
 * Keys describe content, not delivery, acknowledgement, or cross-session deduplication.
 * No private report text, paths, errors, or plan inputs are projected.
 */
export function runAttention(run: RunRecord, settled?: boolean): RunAttention {
  const recovery = runRecovery(run, settled);
  const acceptance = runAcceptance(run);
  const items: AttentionItem[] = [];
  const seen = new Set<string>();
  const add = (kind: AttentionKind, stepId?: string, resultHash?: string) => {
    const content = {
      kind,
      ...(stepId === undefined ? {} : { stepId }),
      ...(resultHash === undefined ? {} : { resultHash }),
    };
    const key = digest({ runId: run.runId, ...content });
    if (!seen.has(key)) {
      seen.add(key);
      items.push({ key, ...content });
    }
  };

  // Recovery owns uncertainty/failure precedence; cleanup is not external completion.
  if (recovery.nextAction === "inspect_external_state")
    add("inspect_external_state");
  else if (recovery.nextAction === "inspect_failure") add("inspect_failure");
  else if (recovery.nextAction === "resume_read_only") add("resume_read_only");

  const workers = [...acceptance.workers].sort((a, b) =>
    a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0,
  );
  for (const worker of workers) {
    if (worker.decisionRequired)
      add("decision_required", worker.stepId, worker.resultHash);
  }

  const results: { stepId: string; resultHash: string }[] = [];
  let complete = true;
  const steps = [...run.steps].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const step of steps) {
    if (step.state !== "succeeded") {
      complete = false;
      continue;
    }
    const stored = Object.hasOwn(run.results, step.id)
      ? run.results[step.id]
      : undefined;
    let resultHash: string | undefined;
    if (stored && !stored.truncated && Object.hasOwn(stored, "value")) {
      try {
        const text = JSON.stringify(stored.value);
        if (text !== undefined)
          resultHash = createHash("sha256").update(text).digest("hex");
      } catch {
        // Non-serializable values cannot constitute a complete saved result.
      }
    }
    if (resultHash === undefined) {
      complete = false;
      add("result_unavailable", step.id);
    } else {
      results.push({ stepId: step.id, resultHash });
    }
  }

  // A single run-level review also covers ordinary-tool results, not just Workers.
  if (
    run.state === "succeeded" &&
    recovery.nextAction === "review_results" &&
    complete &&
    items.length === 0 &&
    ownerReview(run).status !== "accepted"
  )
    add("review_results", undefined, digest(results));

  const snapshotHash = attentionSnapshot(run);
  for (const item of items) {
    if (
      run.acknowledgements?.some(
        (entry) =>
          entry.snapshotHash === snapshotHash && entry.key === item.key,
      )
    )
      item.acknowledged = true;
  }
  // Unknown external effects always remain urgent, even after explicit acknowledgement.
  const alerts = items.filter(
    (item) =>
      NOTIFY_KINDS.has(item.kind) &&
      (!item.acknowledged || item.kind === "inspect_external_state"),
  );
  return {
    ...(snapshotHash === undefined ? {} : { snapshotHash }),
    revision: run.acknowledgements?.at(-1)?.revision ?? 0,
    items,
    notification: {
      key: digest({ runId: run.runId, items: alerts }),
      shouldNotify: alerts.length > 0,
    },
  };
}
