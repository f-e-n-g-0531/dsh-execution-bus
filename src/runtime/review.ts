import { createHash } from "node:crypto";
import type { RunRecord } from "./store.js";

export interface OwnerReviewRecord {
  revision: number;
  snapshotHash: string;
  disposition: "accepted" | "needs_work";
  reason: string;
  at: number;
}
export const MAX_OWNER_REVIEWS = 32;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bind every complete successful result, without treating its contents as evidence. */
export function reviewSnapshot(run: RunRecord): string | undefined {
  if (run.state !== "succeeded" || !run.steps.length) return undefined;
  const results: { stepId: string; resultHash: string }[] = [];
  for (const step of [...run.steps].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )) {
    const stored = Object.hasOwn(run.results, step.id)
      ? run.results[step.id]
      : undefined;
    if (
      step.state !== "succeeded" ||
      !stored ||
      stored.truncated ||
      !Object.hasOwn(stored, "value")
    )
      return undefined;
    try {
      if (JSON.stringify(stored.value) === undefined) return undefined;
      results.push({ stepId: step.id, resultHash: hash(stored.value) });
    } catch {
      return undefined;
    }
  }
  return hash({
    version: 1,
    runId: run.runId,
    plan: run.plan,
    steps: run.steps.map(({ id, tool, state, attempts }) => ({
      id,
      tool,
      state,
      attempts,
    })),
    results,
  });
}

/** Owner declaration only: caller identity does not prove human or independent review. */
export function ownerReview(run: RunRecord) {
  const snapshotHash = reviewSnapshot(run);
  const latest = run.ownerReviews?.at(-1);
  const current = latest !== undefined && latest.snapshotHash === snapshotHash;
  return {
    revision: latest?.revision ?? 0,
    status: current
      ? latest.disposition
      : latest
        ? ("stale" as const)
        : ("not_recorded" as const),
    verification: "owner_declared_not_independently_verified" as const,
    ...(snapshotHash === undefined ? {} : { snapshotHash }),
    ...(latest === undefined ? {} : { recordedAt: latest.at }),
  };
}

/** Validate bounded persisted declarations, not the truth of their reasons. */
export function validOwnerReviews(
  value: unknown,
  createdAt: number,
): value is OwnerReviewRecord[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > MAX_OWNER_REVIEWS
  )
    return false;
  let previousAt = createdAt;
  return value.every((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).length !== 5 ||
      Object.keys(item).some(
        (key) =>
          !["revision", "snapshotHash", "disposition", "reason", "at"].includes(
            key,
          ),
      )
    )
      return false;
    if (
      item.revision !== index + 1 ||
      typeof item.snapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.snapshotHash) ||
      !["accepted", "needs_work"].includes(item.disposition) ||
      typeof item.reason !== "string" ||
      !item.reason.trim() ||
      Buffer.byteLength(item.reason, "utf8") > 2048 ||
      !Number.isSafeInteger(item.at) ||
      item.at < previousAt
    )
      return false;
    previousAt = item.at;
    return true;
  });
}
