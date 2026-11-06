import { createHash } from "node:crypto";
import type { RunRecord } from "./store.js";

export interface AcknowledgementRecord {
  revision: number;
  snapshotHash: string;
  key: string;
  reason: string;
  at: number;
}
export const MAX_ACKNOWLEDGEMENTS = 32;

/** Bind the execution problem version, not delivery, review, or mutable ledger metadata. */
export function attentionSnapshot(run: RunRecord): string | undefined {
  try {
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          runId: run.runId,
          plan: run.plan,
          state: run.state,
          steps: [...run.steps].sort((a, b) =>
            a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
          ),
          results: Object.keys(run.results)
            .sort()
            .map((key) => [key, run.results[key]]),
          error: run.error,
        }),
      )
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** Strict bounded owner declarations; validity does not prove resolution. */
export function validAcknowledgements(
  value: unknown,
  createdAt: number,
): value is AcknowledgementRecord[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_ACKNOWLEDGEMENTS
  )
    return false;
  let previous = createdAt;
  return value.every((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 5 ||
      Object.keys(item).some(
        (key) =>
          !["revision", "snapshotHash", "key", "reason", "at"].includes(key),
      ) ||
      item.revision !== index + 1 ||
      typeof item.snapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.snapshotHash) ||
      typeof item.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.key) ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      Buffer.byteLength(item.reason, "utf8") > 2048 ||
      !Number.isSafeInteger(item.at) ||
      item.at < previous
    )
      return false;
    previous = item.at;
    return true;
  });
}
