import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ERRORS } from "../error-codes.js";
import { parsePlan, RUNTIME_LIMITS } from "./plan.js";
import type { Plan } from "./plan.js";
import { validWorkerTrace } from "./agent-trace.js";
import type { WorkerTrace } from "./agent-trace.js";

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
  childSessionId?: string;
  workerTrace?: WorkerTrace;
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
// A live owner checkpoints at every step boundary, and a single attempt is
// bounded by its timeout (<10 min) plus bounded retry backoff. A running
// record whose foreign PID still probes alive but has not checkpointed for an
// hour is therefore a dead owner whose PID was reused, not a live run: recover
// it instead of stranding the record with no resume/cancel/prune path.
const STALE_RUNNING_MS = 3_600_000;
// Process-wide derived metadata only: never retain a RunRecord or its payload.
const METADATA_ENTRIES = 16_384;
const METADATA_BYTES = 4 * 1024 * 1024;
interface RunMetadata {
  runId: string;
  ownerSessionId: string;
  state: RunState;
  updatedAt: number;
  signature: string;
}
interface CachedMetadata {
  metadata: Readonly<RunMetadata>;
  bytes: number;
}
const metadataCache = new Map<string, CachedMetadata>();
let metadataBytes = 0;

function signature(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ].join(":");
}
function metadata(run: RunRecord, stamp: string): RunMetadata {
  return {
    runId: run.runId,
    ownerSessionId: run.ownerSessionId,
    state: run.state,
    updatedAt: run.updatedAt,
    signature: stamp,
  };
}
function compareMetadata(a: RunMetadata, b: RunMetadata): number {
  return b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId);
}
function forgetMetadata(key: string): void {
  const entry = metadataCache.get(key);
  if (entry) metadataBytes -= entry.bytes;
  metadataCache.delete(key);
}
function rememberMetadata(key: string, value: RunMetadata): void {
  forgetMetadata(key);
  // Bound retained UTF-8 data plus a fixed per-entry charge, independently of
  // the entry cap. Actual V8 heap overhead is engine-dependent, also bounded by
  // these two caps; this is not an exact heap-size measurement.
  const bytes =
    Buffer.byteLength(key) +
    Buffer.byteLength(value.runId) +
    Buffer.byteLength(value.ownerSessionId) +
    Buffer.byteLength(value.state) +
    Buffer.byteLength(value.signature) +
    64;
  if (bytes > METADATA_BYTES) return;
  while (
    metadataCache.size >= METADATA_ENTRIES ||
    metadataBytes + bytes > METADATA_BYTES
  ) {
    forgetMetadata(metadataCache.keys().next().value!);
  }
  metadataCache.set(key, { metadata: Object.freeze(value), bytes });
  metadataBytes += bytes;
}
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
const PLAN_KEYS = new Set([
  "goal",
  "taskId",
  "previousRunId",
  "steps",
  "concurrency",
]);
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
  "childSessionId",
  "workerTrace",
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
      input:
        step.tool === "agent" && object(step.input)
          ? {
              ...Object.fromEntries(
                Object.entries(step.input).filter(
                  ([key, value]) =>
                    !(key === "access" && value === "read") &&
                    !(
                      key === "write_scopes" &&
                      Array.isArray(value) &&
                      value.length === 0
                    ) &&
                    !(key === "max_steps" && value === 12),
                ),
              ),
            }
          : step.input,
      ...(step.dependsOn.length === 0 ? {} : { depends_on: step.dependsOn }),
      ...(step.retry === 0 ? {} : { retry: step.retry }),
      ...(step.timeoutMs === 120000 ? {} : { timeout_ms: step.timeoutMs }),
    });
  }
  let parsed: Plan;
  try {
    parsed = parsePlan({
      ...(plan.goal === undefined ? {} : { goal: plan.goal }),
      ...(plan.taskId === undefined ? {} : { task_id: plan.taskId }),
      ...(plan.previousRunId === undefined
        ? {}
        : { previous_run_id: plan.previousRunId }),
      steps: rawSteps,
      ...(plan.concurrency === 2 ? {} : { concurrency: plan.concurrency }),
    });
  } catch {
    return false;
  }
  const storedSteps = plan.steps;
  if (
    parsed.taskId !== plan.taskId ||
    parsed.previousRunId !== plan.previousRunId ||
    plan.previousRunId === value.runId ||
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
      !optionalText(step.error) ||
      (step.workerTrace !== undefined &&
        (step.tool !== "agent" ||
          !step.childSessionId ||
          !validWorkerTrace(step.workerTrace))) ||
      (step.childSessionId !== undefined &&
        (step.tool !== "agent" ||
          typeof step.childSessionId !== "string" ||
          !step.childSessionId.trim() ||
          step.childSessionId.length > 1024 ||
          step.attempts === 0))
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
    forgetMetadata(path.resolve(target));
    const temp = target + "." + randomUUID() + ".tmp";
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(temp, "wx", 0o600);
      created = true;
      writeFileSync(fd, json, "utf8");
      // Durability: flush the temp content before the atomic replacement so a
      // post-rename reader never observes a torn or zero-length checkpoint
      // after power loss. A lost rename itself rolls back to the previous
      // checkpoint, which the recovery scan already handles; directory fsync
      // is not portable to Windows.
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, target);
      // A successful rename consumed our unique temporary file. Only failures
      // need cleanup; probing the missing old path adds I/O to every checkpoint.
      created = false;
    } catch (cause) {
      this.count("writeFailures");
      // Retain the syscall/code for local diagnostics; summaries still expose
      // only the stable runtime error code, never the underlying path.
      throw Error(ERRORS.RUNTIME_STORAGE_FAILED, { cause });
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
    // Public reads are authoritative, full, strictly validated snapshots. A stat
    // signature can accelerate candidate selection, never authorize a result.
    return this.readRecord(runId)?.run;
  }

  private readRecord(
    runId: string,
    hint = false,
  ): { run?: RunRecord; metadata: RunMetadata } | undefined {
    // Reject malformed run IDs before any filesystem accounting: a caller
    // error is not a storage read failure and must not inflate diagnostics.
    let target: string;
    try {
      target = this.pathFor(runId);
    } catch {
      return undefined;
    }
    let fd: number | undefined;
    let key: string | undefined;
    try {
      key = path.resolve(target);
      fd = openSync(target, "r");
      const stat = fstatSync(fd, { bigint: true });
      if (!stat.isFile()) {
        forgetMetadata(key);
        this.count("invalidRecords");
        return undefined;
      }
      if (stat.size > BigInt(RECORD_BYTES)) {
        forgetMetadata(key);
        this.count("oversizedRecords");
        return undefined;
      }
      const stamp = signature(stat);
      const cached = hint ? metadataCache.get(key) : undefined;
      if (cached?.metadata.signature === stamp) {
        // Even a hit opens and fstats the descriptor twice. No raw record escapes
        // the cache, and callers receive a copy of the small derived metadata.
        if (signature(fstatSync(fd, { bigint: true })) !== stamp) {
          forgetMetadata(key);
          this.count("invalidRecords");
          return undefined;
        }
        metadataCache.delete(key);
        metadataCache.set(key, cached);
        return { metadata: { ...cached.metadata } };
      }
      forgetMetadata(key);
      const size = Number(stat.size);
      // The descriptor can grow after stat: never read more than cap plus one.
      const bytes = Buffer.alloc(size + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > RECORD_BYTES) {
        this.count("oversizedRecords");
        return undefined;
      }
      if (
        length !== size ||
        signature(fstatSync(fd, { bigint: true })) !== stamp
      ) {
        this.count("invalidRecords");
        return undefined;
      }
      try {
        const value: unknown = JSON.parse(bytes.toString("utf8", 0, length));
        if (validRun(value, runId)) {
          const derived = metadata(value, stamp);
          rememberMetadata(key, derived);
          return { run: value, metadata: { ...derived } };
        }
      } catch {
        /* malformed JSON and invalid plans are isolated */
      }
      this.count("invalidRecords");
      return undefined;
    } catch (error) {
      if (key) forgetMetadata(key);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.count("readFailures");
      return undefined;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          if (key) forgetMetadata(key);
          this.count("readFailures");
        }
      }
    }
  }

  private scan(hint = false): RunMetadata[] {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      this.count("readFailures");
      return [];
    }
    const runs: RunMetadata[] = [];
    for (const name of names) {
      if (!name.endsWith(".json") || !RUN_ID.test(name.slice(0, -5))) continue;
      const entry = this.readRecord(name.slice(0, -5), hint);
      if (entry) runs.push(entry.metadata);
    }
    return runs.sort(compareMetadata);
  }

  list(limit = 20, ownerSessionId?: string, offset = 0): RunRecord[] {
    if (!timestamp(limit) || !timestamp(offset))
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    const end = Math.min(Number.MAX_SAFE_INTEGER, offset + limit);
    // A changed selected page is retried, not silently shortened or refilled out
    // of order. Under persistent churn return no page rather than wrong offsets.
    for (let attempt = 0; attempt < 2; attempt++) {
      const candidates = this.scan(true).filter(
        (entry) =>
          ownerSessionId === undefined ||
          entry.ownerSessionId === ownerSessionId,
      );
      const page: RunRecord[] = [];
      let changed = false;
      for (const candidate of candidates.slice(offset, end)) {
        const fresh = this.readRecord(candidate.runId);
        if (
          !fresh?.run ||
          fresh.metadata.signature !== candidate.signature ||
          fresh.metadata.ownerSessionId !== candidate.ownerSessionId ||
          fresh.metadata.updatedAt !== candidate.updatedAt ||
          fresh.metadata.state !== candidate.state
        ) {
          changed = true;
          break;
        }
        page.push(fresh.run);
      }
      if (!changed) return page;
    }
    return [];
  }

  remove(runId: string): void {
    const target = this.pathFor(runId);
    forgetMetadata(path.resolve(target));
    try {
      rmSync(target, { force: true });
    } catch {
      this.count("writeFailures");
      throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
    }
  }

  /** Retain newest max terminal runs; active and recoverable runs never count. */
  prune(max = 100): void {
    if (!timestamp(max)) throw Error(ERRORS.RUNTIME_INVALID_STATE);
    this.pruneScanned(this.scan(), max);
  }

  private pruneScanned(scanned: RunMetadata[], max: number): void {
    // Destructive decisions start from uncached reads. If a retained boundary or
    // candidate changed, stop conservatively rather than delete a new checkpoint.
    const terminal = scanned.filter((entry) => TERMINAL.has(entry.state));
    if (terminal.length <= max) return;
    const retained = terminal.slice(0, max);
    // Revalidate the retained set once, not max times for every deletion. This
    // is deliberately not a cross-process transaction or lock.
    for (const boundary of retained) {
      const guard = this.readRecord(boundary.runId);
      if (
        !guard?.run ||
        guard.metadata.signature !== boundary.signature ||
        !TERMINAL.has(guard.run.state)
      )
        return;
    }
    for (const candidate of terminal.slice(max)) {
      const fresh = this.readRecord(candidate.runId);
      if (
        !fresh?.run ||
        fresh.metadata.signature !== candidate.signature ||
        !TERMINAL.has(fresh.run.state) ||
        retained.some(
          (boundary) => compareMetadata(boundary, fresh.metadata) > 0,
        )
      )
        return;
      this.remove(candidate.runId);
    }
  }

  /** One uncached enumeration for scope initialization; mutations still reread. */
  maintain(exclude: ReadonlySet<string> = new Set(), max = 100): number {
    if (!timestamp(max)) throw Error(ERRORS.RUNTIME_INVALID_STATE);
    const scanned = this.scan();
    const count = this.interruptScanned(scanned, exclude);
    this.pruneScanned(scanned, max);
    return count;
  }

  /** Recover abandoned running records; legacy records without PID supported. */
  markInterrupted(exclude: ReadonlySet<string> = new Set()): number {
    return this.interruptScanned(this.scan(), exclude);
  }

  private interruptScanned(
    scanned: RunMetadata[],
    exclude: ReadonlySet<string>,
  ): number {
    let count = 0;
    for (const candidate of scanned) {
      if (candidate.state !== "running" || exclude.has(candidate.runId))
        continue;
      const fresh = this.readRecord(candidate.runId);
      if (!fresh?.run || fresh.metadata.signature !== candidate.signature)
        continue;
      const run = fresh.run;
      // PID liveness alone cannot prove owner identity: a reused PID keeps a
      // dead owner's record alive forever. Freshness bounds that trust window.
      const foreignAlive =
        run.ownerPid !== undefined &&
        run.ownerPid !== process.pid &&
        alive(run.ownerPid) &&
        Date.now() - run.updatedAt < STALE_RUNNING_MS;
      if (run.state !== "running" || foreignAlive) continue;
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
