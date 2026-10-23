import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ERRORS } from "../error-codes.js";
import { parsePlan, RUNTIME_LIMITS } from "./plan.js";
import type { Plan } from "./plan.js";

export type RunState =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type StepState =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface StepRecord {
  id: string;
  tool: string;
  state: StepState;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}
export interface StoredResult {
  value?: unknown;
  truncated?: true;
  bytes?: number;
}
export interface RunRecord {
  version: 1;
  runId: string;
  ownerSessionId: string;
  ownerPid?: number;
  ownerProcess?: string;
  goal?: string;
  plan: Plan;
  state: RunState;
  steps: StepRecord[];
  results: Record<string, StoredResult>;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
}

const RUN_ID = /^run-[0-9a-z-]{8,80}$/;
const RECORD_BYTES = 4 * 1024 * 1024;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const RUN_STATES = new Set(["running", "interrupted", ...TERMINAL]);
const STEP_STATES = new Set([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
const RUN_KEYS = new Set([
  "version",
  "runId",
  "ownerSessionId",
  "ownerPid",
  "ownerProcess",
  "goal",
  "plan",
  "state",
  "steps",
  "results",
  "createdAt",
  "updatedAt",
  "finishedAt",
  "error",
]);
const PLAN_KEYS = new Set(["goal", "steps", "concurrency"]);
const PLAN_STEP_KEYS = new Set([
  "id",
  "tool",
  "input",
  "dependsOn",
  "retry",
  "timeoutMs",
]);
const STEP_KEYS = new Set([
  "id",
  "tool",
  "state",
  "attempts",
  "startedAt",
  "finishedAt",
  "error",
]);
const RESULT_KEYS = new Set(["value", "truncated", "bytes"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Validate the version-1 internal Plan, not the public snake_case input shape. */
function validRun(value: unknown, runId: string): value is RunRecord {
  if (
    !object(value) ||
    !keys(value, RUN_KEYS) ||
    value.version !== 1 ||
    value.runId !== runId
  )
    return false;
  if (
    typeof value.ownerSessionId !== "string" ||
    !value.ownerSessionId.trim() ||
    value.ownerSessionId.length > 1024
  )
    return false;
  if (
    value.ownerPid !== undefined &&
    (!timestamp(value.ownerPid) ||
      value.ownerPid < 1 ||
      value.ownerPid > 0x7fffffff)
  )
    return false;
  if (
    value.ownerProcess !== undefined &&
    (typeof value.ownerProcess !== "string" ||
      !value.ownerProcess.trim() ||
      value.ownerProcess.length > 1024)
  )
    return false;
  if (
    !optionalText(value.error) ||
    !RUN_STATES.has(value.state as string) ||
    (value.state === "succeeded" && value.error !== undefined)
  )
    return false;
  if (
    !timestamp(value.createdAt) ||
    !timestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  )
    return false;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const withinRun = (time: unknown) =>
    timestamp(time) && time >= createdAt && time <= updatedAt;
  if (value.state === "running") {
    if (value.finishedAt !== undefined) return false;
  } else if (!withinRun(value.finishedAt)) return false;

  const plan = value.plan;
  if (
    !object(plan) ||
    !keys(plan, PLAN_KEYS) ||
    !Array.isArray(plan.steps) ||
    !timestamp(plan.concurrency)
  )
    return false;
  const rawSteps: Record<string, unknown>[] = [];
  for (const step of plan.steps) {
    if (
      !object(step) ||
      !keys(step, PLAN_STEP_KEYS) ||
      !Array.isArray(step.dependsOn) ||
      !timestamp(step.retry) ||
      !timestamp(step.timeoutMs)
    )
      return false;
    // Reconstruct the shortest equivalent public input: normalization adds defaults
    // that were not charged against the original 64KiB input budget.
    rawSteps.push({
      id: step.id,
      tool: step.tool,
      input: step.input,
      ...(step.dependsOn.length === 0 ? {} : { depends_on: step.dependsOn }),
      ...(step.retry === 0 ? {} : { retry: step.retry }),
      ...(step.timeoutMs === 120000 ? {} : { timeout_ms: step.timeoutMs }),
    });
  }
  let parsed: Plan;
  try {
    parsed = parsePlan({
      ...(plan.goal === undefined ? {} : { goal: plan.goal }),
      steps: rawSteps,
      ...(plan.concurrency === 2 ? {} : { concurrency: plan.concurrency }),
    });
  } catch {
    return false;
  }
  const storedSteps = plan.steps;
  if (
    parsed.concurrency !== plan.concurrency ||
    parsed.steps.some((spec, index) => {
      const stored = storedSteps[index];
      return (
        spec.id !== stored.id ||
        spec.tool !== stored.tool ||
        spec.retry !== stored.retry ||
        spec.timeoutMs !== stored.timeoutMs ||
        JSON.stringify(spec.dependsOn) !== JSON.stringify(stored.dependsOn) ||
        JSON.stringify(spec.input) !== JSON.stringify(stored.input)
      );
    })
  )
    return false;
  if (
    value.goal !== parsed.goal ||
    !Array.isArray(value.steps) ||
    value.steps.length !== parsed.steps.length ||
    !object(value.results)
  )
    return false;
  const records = new Map<string, Record<string, unknown>>();
  for (const step of value.steps) {
    if (
      !object(step) ||
      !keys(step, STEP_KEYS) ||
      typeof step.id !== "string" ||
      records.has(step.id)
    )
      return false;
    const spec = parsed.steps.find((candidate) => candidate.id === step.id);
    if (
      !spec ||
      spec.tool !== step.tool ||
      !STEP_STATES.has(step.state as string) ||
      !timestamp(step.attempts) ||
      !optionalText(step.error)
    )
      return false;
    if (step.startedAt !== undefined && !withinRun(step.startedAt))
      return false;
    if (step.finishedAt !== undefined) {
      if (
        !timestamp(step.finishedAt) ||
        !withinRun(step.finishedAt) ||
        (timestamp(step.startedAt) && step.finishedAt < step.startedAt)
      )
        return false;
    }
    if (step.attempts === 0 && step.startedAt !== undefined) return false;
    if (
      step.attempts > 0 &&
      step.state !== "pending" &&
      step.startedAt === undefined
    )
      return false;
    if (step.state === "succeeded" && step.error !== undefined) return false;
    if (value.state === "cancelled" && step.state === "pending") return false;
    if (step.state === "pending") {
      if (step.finishedAt !== undefined) return false;
    } else if (step.state === "running") {
      if (
        step.attempts === 0 ||
        step.startedAt === undefined ||
        step.finishedAt !== undefined ||
        value.state !== "running"
      )
        return false;
    } else {
      if (step.finishedAt === undefined) return false;
      if (
        step.state !== "cancelled" &&
        (step.attempts === 0 || step.startedAt === undefined)
      )
        return false;
    }
    if (
      value.finishedAt !== undefined &&
      timestamp(step.finishedAt) &&
      step.finishedAt > (value.finishedAt as number)
    )
      return false;
    if (value.state === "succeeded" && step.state !== "succeeded") return false;
    records.set(step.id, step);
  }
  for (const spec of parsed.steps) {
    const record = records.get(spec.id)!;
    if (record.attempts !== 0) {
      for (const dependency of spec.dependsOn) {
        const parent = records.get(dependency)!;
        if (
          parent.state !== "succeeded" ||
          (timestamp(record.startedAt) &&
            timestamp(parent.finishedAt) &&
            record.startedAt < parent.finishedAt)
        )
          return false;
      }
    }
  }
  for (const [id, result] of Object.entries(value.results)) {
    const state = records.get(id)?.state;
    if (
      (state !== "succeeded" && state !== "unknown" && state !== "failed") ||
      !object(result) ||
      !keys(result, RESULT_KEYS)
    )
      return false;
    if (result.bytes !== undefined && !timestamp(result.bytes)) return false;
    if (result.truncated !== undefined && result.truncated !== true)
      return false;
    if (result.truncated === true) {
      if (
        Object.hasOwn(result, "value") ||
        (timestamp(result.bytes) && result.bytes <= RUNTIME_LIMITS.resultBytes)
      )
        return false;
    } else {
      if (!Object.hasOwn(result, "value")) return false;
      try {
        const bytes = Buffer.byteLength(JSON.stringify(result.value));
        if (
          bytes > RUNTIME_LIMITS.resultBytes ||
          (result.bytes !== undefined &&
            result.bytes !== bytes &&
            !(result.value === null && result.bytes === 0))
        )
          return false;
      } catch {
        return false;
      }
    }
  }
  for (const [id, record] of records) {
    if (record.state === "succeeded" && !Object.hasOwn(value.results, id))
      return false;
  }
  return true;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial is not evidence that a process has died.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function defaultRunRoot(): string {
  if (process.env.XIAOHE_RUNTIME_DIR)
    return path.resolve(process.env.XIAOHE_RUNTIME_DIR);
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "tmp", "xiaohe-runtime", "runs");
}

/** Pure file persistence: bounded reads, atomic replacement, no cross-process lock. */
export class RunStore {
  private readonly counters = {
    invalidRecords: 0,
    oversizedRecords: 0,
    readFailures: 0,
    writeFailures: 0,
  };

  constructor(readonly root: string = defaultRunRoot()) {
    try {
      mkdirSync(this.root, { recursive: true });
    } catch {
      throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
    }
  }

  /** Fixed-size, saturated counters only: never return paths, IDs or record contents. */
  diagnostics(): Readonly<typeof this.counters> {
    return { ...this.counters };
  }

  private count(key: keyof typeof this.counters): void {
    this.counters[key] = Math.min(1_000_000, this.counters[key] + 1);
  }

  pathFor(runId: string): string {
    if (!RUN_ID.test(runId)) throw Error(ERRORS.RUNTIME_NOT_FOUND);
    return path.join(this.root, runId + ".json");
  }

  save(run: RunRecord): void {
    const target = this.pathFor(run.runId);
    let json: string;
    try {
      json = JSON.stringify(run);
      if (
        Buffer.byteLength(json) > RECORD_BYTES ||
        !validRun(JSON.parse(json), run.runId)
      )
        throw Error();
    } catch {
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    }
    const temp = target + "." + randomUUID() + ".tmp";
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(temp, "wx", 0o600);
      created = true;
      writeFileSync(fd, json, "utf8");
      closeSync(fd);
      fd = undefined;
      renameSync(temp, target);
    } catch {
      this.count("writeFailures");
      throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* preserve the original failure */
        }
      }
      if (created) {
        try {
          rmSync(temp, { force: true });
        } catch {
          /* best effort after failed writes */
        }
      }
    }
  }

  load(runId: string): RunRecord | undefined {
    let fd: number | undefined;
    let text: string;
    try {
      fd = openSync(this.pathFor(runId), "r");
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        this.count("invalidRecords");
        return undefined;
      }
      if (stat.size > RECORD_BYTES) {
        this.count("oversizedRecords");
        return undefined;
      }
      // The descriptor can grow after stat: never read more than the cap plus one.
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length > RECORD_BYTES) {
        this.count("oversizedRecords");
        return undefined;
      }
      if (length > stat.size) {
        this.count("invalidRecords");
        return undefined;
      }
      text = bytes.toString("utf8", 0, length);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.count("readFailures");
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          this.count("readFailures");
        }
      }
    }
    try {
      const value: unknown = JSON.parse(text);
      if (validRun(value, runId)) return value;
    } catch {
      /* malformed JSON and invalid plans are isolated */
    }
    this.count("invalidRecords");
    return undefined;
  }

  private scan(ownerSessionId?: string): RunRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      this.count("readFailures");
      return [];
    }
    const runs: RunRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !RUN_ID.test(name.slice(0, -5))) continue;
      const run = this.load(name.slice(0, -5));
      if (
        run &&
        (ownerSessionId === undefined || run.ownerSessionId === ownerSessionId)
      )
        runs.push(run);
    }
    return runs.sort(
      (a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId),
    );
  }

  list(limit = 20, ownerSessionId?: string, offset = 0): RunRecord[] {
    if (!timestamp(limit) || !timestamp(offset))
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    const end = Math.min(Number.MAX_SAFE_INTEGER, offset + limit);
    return this.scan(ownerSessionId).slice(offset, end);
  }

  remove(runId: string): void {
    const target = this.pathFor(runId);
    try {
      rmSync(target, { force: true });
    } catch {
      this.count("writeFailures");
      throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
    }
  }

  /** Retain the newest max terminal runs; active and recoverable runs never count toward the budget. */
  prune(max = 100): void {
    if (!timestamp(max)) throw Error(ERRORS.RUNTIME_INVALID_STATE);
    for (const run of this.scan()
      .filter((run) => TERMINAL.has(run.state))
      .slice(max))
      this.remove(run.runId);
  }

  /** Recover only abandoned running records; legacy records without a PID remain supported. */
  markInterrupted(exclude: ReadonlySet<string> = new Set()): number {
    let count = 0;
    for (const run of this.scan()) {
      if (
        run.state !== "running" ||
        exclude.has(run.runId) ||
        (run.ownerPid !== undefined &&
          run.ownerPid !== process.pid &&
          alive(run.ownerPid))
      )
        continue;
      const now = Math.max(Date.now(), run.updatedAt);
      run.state = "interrupted";
      run.error = ERRORS.RUNTIME_INTERRUPTED;
      run.finishedAt = now;
      for (const step of run.steps) {
        if (step.state === "running") {
          step.state = "unknown";
          step.error = ERRORS.RUNTIME_INTERRUPTED;
          step.finishedAt = now;
        }
      }
      run.updatedAt = now;
      this.save(run);
      count++;
    }
    return count;
  }
}
