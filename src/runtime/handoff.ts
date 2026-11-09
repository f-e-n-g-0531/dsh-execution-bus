import { createHash } from "node:crypto";
import { ERRORS } from "../error-codes.js";
import type { RunRecord } from "./store.js";

export interface HandoffSelection {
  stepId: string;
  resultHash: string;
}
export interface HandoffSnapshot {
  kind: "untrusted_run_handoff";
  sourceRunId: string;
  taskId: string;
  summary: string;
  selections: HandoffSelection[];
  snapshotHash: string;
  authorized: false;
  executable: false;
}
export interface HandoffInput {
  runId: string;
  selections: HandoffSelection[];
  summary: string;
}
const RUN_ID = /^run-[0-9a-z-]{8,80}$/;
const ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const SNAPSHOT_BYTES = 12 * 1024;
function invalid(): never {
  throw Error(ERRORS.INVALID_PLAN);
}
/** Reject accessors before reading any value, including array entries and toJSON. */
function exact(raw: unknown, names: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== null && proto !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== names.length) invalid();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string" || !names.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalid();
    copy[key] = descriptor.value;
  }
  return copy;
}
function selections(raw: unknown): HandoffSelection[] {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) invalid();
  if (raw.length < 1 || raw.length > 8 || Reflect.ownKeys(raw).length !== raw.length + 1) invalid();
  const ids = new Set<string>();
  const result: HandoffSelection[] = [];
  for (let i = 0; i < raw.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    const item = exact(descriptor.value, ["stepId", "resultHash"]);
    if (typeof item.stepId !== "string" || !ID.test(item.stepId) || ids.has(item.stepId) ||
        typeof item.resultHash !== "string" || !HASH.test(item.resultHash)) invalid();
    ids.add(item.stepId);
    result.push({ stepId: item.stepId, resultHash: item.resultHash });
  }
  return result;
}
function summary(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw, "utf8") > 4096 ||
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(raw)) invalid();
  for (const char of raw) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) invalid();
  }
  return raw;
}
export function parseHandoffInput(raw: unknown): HandoffInput {
  const value = exact(raw, ["runId", "selections", "summary"]);
  if (typeof value.runId !== "string" || !RUN_ID.test(value.runId)) invalid();
  return { runId: value.runId, selections: selections(value.selections), summary: summary(value.summary) };
}
/** Fixed insertion order, selection order preserved. Hash excludes hash and fixed false flags. */
function digest(value: Omit<HandoffSnapshot, "snapshotHash" | "authorized" | "executable">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function snapshot(input: HandoffInput, taskId: string): HandoffSnapshot {
  const body = {
    kind: "untrusted_run_handoff" as const,
    sourceRunId: input.runId,
    taskId,
    summary: input.summary,
    selections: input.selections,
  };
  const result: HandoffSnapshot = { ...body, snapshotHash: digest(body), authorized: false, executable: false };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") >= SNAPSHOT_BYTES) invalid();
  return result;
}
/** Pure structural/integrity validation; the service must separately revalidate the source. */
export function parseHandoffSnapshot(raw: unknown): HandoffSnapshot {
  const value = exact(raw, ["kind", "sourceRunId", "taskId", "summary", "selections", "snapshotHash", "authorized", "executable"]);
  if (value.kind !== "untrusted_run_handoff" || value.authorized !== false || value.executable !== false ||
      typeof value.taskId !== "string" || !ID.test(value.taskId) ||
      typeof value.snapshotHash !== "string" || !HASH.test(value.snapshotHash)) invalid();
  const input = parseHandoffInput({ runId: value.sourceRunId, summary: value.summary, selections: value.selections });
  const result = snapshot(input, value.taskId);
  if (result.snapshotHash !== value.snapshotHash) throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
  return result;
}
/** No result payload escapes this function; no authority or execution is conveyed. */
export function createHandoffSnapshot(input: HandoffInput, source: RunRecord): HandoffSnapshot {
  if (!source.plan.taskId || !ID.test(source.plan.taskId)) throw Error(ERRORS.RUNTIME_INVALID_STATE);
  const parsed = parseHandoffInput(input);
  if (parsed.runId !== source.runId) throw Error(ERRORS.INVALID_PLAN);
  verifyHandoffSelections(parsed.selections, source);
  return snapshot(parsed, source.plan.taskId);
}
export function verifyHandoffSelections(items: HandoffSelection[], source: RunRecord): void {
  for (const item of items) {
    const step = source.steps.find((entry) => entry.id === item.stepId);
    if (!step) throw Error(ERRORS.RUNTIME_NOT_FOUND);
    const stored = Object.hasOwn(source.results, item.stepId) ? source.results[item.stepId] : undefined;
    if (step.state !== "succeeded" || !stored || stored.truncated || !Object.hasOwn(stored, "value"))
      throw Error(ERRORS.RUNTIME_RESULT_UNAVAILABLE);
    let text: string | undefined;
    try { text = JSON.stringify(stored.value); } catch { throw Error(ERRORS.RUNTIME_RESULT_UNAVAILABLE); }
    if (text === undefined || Buffer.byteLength(text, "utf8") > 64 * 1024)
      throw Error(ERRORS.RUNTIME_RESULT_UNAVAILABLE);
    if (createHash("sha256").update(text).digest("hex") !== item.resultHash)
      throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
  }
}
