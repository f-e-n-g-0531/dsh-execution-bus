import type { RunRecord } from "./store.js";
import type { RunAttention } from "./attention.js";
export type DecisionDisposition = "answered" | "superseded" | "dismissed";
export interface DecisionRecord {
  revision: number;
  snapshotHash: string;
  key: string;
  disposition: DecisionDisposition;
  reason: string;
  answerRef?: string;
  successorRunId?: string;
  at: number;
}
export interface DecisionInput {
  snapshotHash: string;
  key: string;
  expectedRevision: number;
  disposition: DecisionDisposition;
  reason: string;
  answerRef?: string;
  successorRunId?: string;
}
export const MAX_DECISIONS = 32;
const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^run-[0-9a-z-]{8,80}$/;
export function validDecisionText(value: unknown, ref = false): value is string {
  return typeof value === "string" && !!value.trim() &&
    !Array.from(value).some((char) => { const n = char.charCodeAt(0); return n < 32 || (n >= 127 && n <= 159); }) &&
    (ref ? value.length <= 1000 : Buffer.byteLength(value, "utf8") <= 2048);
}
export function validDecisionInput(value: DecisionInput): boolean {
  return typeof value.snapshotHash === "string" && HASH.test(value.snapshotHash) &&
    typeof value.key === "string" && HASH.test(value.key) &&
    Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 &&
    ["answered", "superseded", "dismissed"].includes(value.disposition) &&
    validDecisionText(value.reason) &&
    (value.answerRef === undefined ? value.disposition !== "answered" : validDecisionText(value.answerRef, true)) &&
    (value.successorRunId === undefined || (typeof value.successorRunId === "string" && RUN_ID.test(value.successorRunId)));
}
export function validDecisionDispositions(value: unknown, createdAt: number): value is DecisionRecord[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_DECISIONS) return false;
  let previous = createdAt;
  return value.every((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
      Object.keys(item).some((key) => !["revision", "snapshotHash", "key", "disposition", "reason", "answerRef", "successorRunId", "at"].includes(key)) ||
      item.revision !== index + 1 || !validDecisionInput({ ...item, expectedRevision: index }) ||
      item.reason !== item.reason.trim() ||
      (item.answerRef !== undefined && item.answerRef !== item.answerRef.trim()) ||
      !Number.isSafeInteger(item.at) || item.at < previous) return false;
    previous = item.at;
    return true;
  });
}
/** Current declarations only; stale history never closes a new execution snapshot. */
export function currentDecision(run: RunRecord, snapshotHash: string | undefined, key: string): DecisionRecord | undefined {
  if (!snapshotHash) return undefined;
  return run.decisionDispositions?.findLast((entry) => entry.snapshotHash === snapshotHash && entry.key === key);
}
export function decisionLedger(run: RunRecord, attention: RunAttention) {
  return {
    revision: run.decisionDispositions?.at(-1)?.revision ?? 0,
    verification: "owner_declared_not_user_approval" as const,
    items: attention.items.filter((item) => item.kind === "decision_required").map((item) => {
      const record = currentDecision(run, attention.snapshotHash, item.key);
      return {
        key: item.key,
        ...(item.stepId === undefined ? {} : { stepId: item.stepId }),
        ...(item.resultHash === undefined ? {} : { resultHash: item.resultHash }),
        status: record?.disposition ?? ("open" as const),
        ...(record === undefined ? {} : { recordedAt: record.at }),
      };
    }),
  };
}
