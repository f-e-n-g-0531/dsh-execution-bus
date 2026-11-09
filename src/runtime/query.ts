import { ERRORS } from "../error-codes.js";
import { runAction } from "./action.js";
import type { RunActionKind } from "./action.js";
import type { RunRecord, RunState } from "./store.js";

export interface QueryInput {
  q?: string;
  taskId?: string;
  state?: RunState;
  action?: RunActionKind;
  view: "all" | "needs_action" | "review";
  limit: number;
  offset: number;
}

export interface QueryResult {
  runs: RunRecord[];
  /** Number after all filters, including view, and before pagination. */
  matchedCount: number;
  /** Exclusive action groups before view filtering and pagination. */
  groups: { needsAction: number; review: number };
  hasMore: boolean;
}

const KEYS = new Set(["q", "taskId", "state", "action", "view", "limit", "offset"]);
const STATES: ReadonlySet<string> = new Set([
  "running", "succeeded", "failed", "cancelled", "interrupted",
]);
const ACTIONS: ReadonlySet<RunActionKind> = new Set([
  "inspect_external_state", "wait_cleanup", "inspect_failure", "decision_required",
  "result_unavailable", "resume_read_only", "review_results", "wait_retry", "working", "settled",
]);
const TASK_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function invalid(): never {
  throw Error(ERRORS.INVALID_PLAN);
}

/** Strict JSON-shaped input: never invoke accessors or coerce values. */
export function parseQuery(raw: unknown): QueryInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) invalid();
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string" || !KEYS.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    // Present optional fields must have their declared type, not null/undefined.
    if (descriptor.value === undefined) invalid();
    fields[key] = descriptor.value;
  }
  const result: QueryInput = { view: "all", limit: 20, offset: 0 };
  if (Object.hasOwn(fields, "q")) {
    if (typeof fields.q !== "string" || fields.q.length > 256) invalid();
    const q = fields.q.trim();
    if (!q || q.length > 256) invalid();
    result.q = q;
  }
  if (Object.hasOwn(fields, "taskId")) {
    if (typeof fields.taskId !== "string" || !TASK_ID.test(fields.taskId)) invalid();
    result.taskId = fields.taskId;
  }
  if (Object.hasOwn(fields, "state")) {
    if (typeof fields.state !== "string" || !STATES.has(fields.state)) invalid();
    result.state = fields.state as RunState;
  }
  if (Object.hasOwn(fields, "action")) {
    if (typeof fields.action !== "string" || !ACTIONS.has(fields.action as RunActionKind)) invalid();
    result.action = fields.action as RunActionKind;
  }
  if (Object.hasOwn(fields, "view")) {
    if (fields.view !== "all" && fields.view !== "needs_action" && fields.view !== "review") invalid();
    result.view = fields.view;
  }
  for (const key of ["limit", "offset"] as const) {
    if (!Object.hasOwn(fields, key)) continue;
    const value = fields[key];
    if (typeof value !== "number" || !Number.isInteger(value) ||
      value < (key === "limit" ? 1 : 0) || value > (key === "limit" ? 100 : 1000)) invalid();
    result[key] = value;
  }
  return result;
}

/** Owner-scoped records are supplied by the caller; this function never loads data. */
export function queryRuns(
  runs: RunRecord[],
  input: QueryInput,
  settled: (runId: string) => boolean | undefined,
): QueryResult {
  const q = input.q?.toLowerCase();
  const groups = { needsAction: 0, review: 0 };
  const matches: RunRecord[] = [];
  for (const run of runs) {
    if (input.taskId !== undefined && run.plan.taskId !== input.taskId) continue;
    if (input.state !== undefined && run.state !== input.state) continue;
    if (q !== undefined) {
      const provenance = run.plan.provenance;
      const metadata = [run.goal, provenance?.request_ref, provenance?.scope_summary,
        ...(provenance?.context_refs ?? [])];
      if (!metadata.some((value) => value?.toLowerCase().includes(q))) continue;
    }
    const action = runAction(run, settled(run.runId));
    if (input.action !== undefined && action.kind !== input.action) continue;
    const review = action.kind === "review_results";
    const needsAction = action.actor === "owner" && !review;
    if (review) groups.review++;
    else if (needsAction) groups.needsAction++;
    if (input.view === "review" && !review) continue;
    if (input.view === "needs_action" && !needsAction) continue;
    matches.push(run);
  }
  matches.sort((a, b) => b.updatedAt - a.updatedAt ||
    (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return {
    runs: matches.slice(input.offset, input.offset + input.limit),
    matchedCount: matches.length,
    groups,
    hasMore: input.offset + input.limit < matches.length,
  };
}
