import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { ERRORS } from "../error-codes.js";
import { runProgress, runGuidance } from "../presentation.js";
import type { RunProgress, RunGuidance } from "../presentation.js";
import { RuntimeExecutor } from "./executor.js";
import type { Invoke } from "./executor.js";
import { parsePlan } from "./plan.js";
import type { Plan } from "./plan.js";
import { RunStore } from "./store.js";
import type { RunRecord, StepRecord } from "./store.js";

const MAX_ACTIVE_RUNS = 8;
const PROCESS_ID = randomUUID();
const RUN_KEYS = new Set(["plan", "async"]);
const RUN_ID_KEYS = new Set(["runId"]);
const STATUS_KEYS = new Set(["runId", "limit", "offset"]);
interface ActiveRun {
  owner: RuntimeService;
  run: RunRecord;
  executor: RuntimeExecutor;
  controller: AbortController;
  promise: Promise<RunRecord>;
}
interface RunManager {
  active: Map<string, ActiveRun>;
  failures: Map<string, RunRecord>;
  references: number;
}
// Shared only inside this module/process. A new Agent scope is not a process restart.
const managers = new Map<string, RunManager>();

export interface RunSummary {
  runId: string;
  state: RunRecord["state"];
  goal?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  durationMs: number;
  progress: RunProgress;
  guidance: RunGuidance[];
  steps: Array<{
    id: string;
    tool: string;
    state: StepRecord["state"];
    attempts: number;
    error?: string;
  }>;
}
function summary(run: RunRecord): RunSummary {
  return {
    runId: run.runId,
    state: run.state,
    ...(run.goal === undefined ? {} : { goal: run.goal }),
    ...(run.error === undefined ? {} : { error: run.error }),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    durationMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.createdAt),
    progress: runProgress(run),
    guidance: runGuidance(run),
    steps: run.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      state: step.state,
      attempts: step.attempts,
      ...(step.error === undefined ? {} : { error: step.error }),
    })),
  };
}
function plain(raw: unknown, keys: Set<string>): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error(ERRORS.INVALID_PLAN);
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null)
    throw Error(ERRORS.INVALID_PLAN);
  const value = raw as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.has(key))
      throw Error(ERRORS.INVALID_PLAN);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable)
      throw Error(ERRORS.INVALID_PLAN);
  }
  return value;
}
function pageNumber(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw Error(ERRORS.INVALID_PLAN);
  return value;
}
function validateExecution(plan: Plan) {
  for (const step of plan.steps) {
    if (step.tool === "pwsh" && step.input.run_in_background === true)
      throw Error(ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED);
  }
}

/** Scope facade over a process-wide, root-keyed execution owner. */
export class RuntimeService {
  private readonly store: RunStore;
  private readonly key: string;
  private readonly manager: RunManager;
  private closed = false;
  private disposal?: Promise<void>;

  constructor(
    private readonly ctx: Context,
    store?: RunStore,
  ) {
    this.store = store ?? new RunStore();
    const root = realpathSync(this.store.root);
    this.key = process.platform === "win32" ? root.toLowerCase() : root;
    const manager = managers.get(this.key) ?? {
      active: new Map(),
      failures: new Map(),
      references: 0,
    };
    this.store.markInterrupted(new Set(manager.active.keys()));
    this.store.prune(100);
    manager.references++;
    this.manager = manager;
    managers.set(this.key, manager);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.disposal = Promise.resolve().then(async () => {
      const own = [...this.manager.active.values()].filter(
        (entry) => entry.owner === this,
      );
      for (const entry of own) {
        try {
          entry.executor.cancel(entry.run);
        } catch {
          this.rememberStorageFailure(entry.run);
        } finally {
          entry.controller.abort();
        }
      }
      await Promise.allSettled(own.map((entry) => entry.promise));
      this.manager.references--;
      this.releaseManager();
    });
    return this.disposal;
  }

  async run(
    raw: unknown,
    exec: ToolRunContext,
    background = false,
  ): Promise<RunSummary | { runId: string; state: "running" }> {
    this.ensureOpen();
    const sessionId = this.sessionId(exec);
    const input = plain(raw, RUN_KEYS);
    const plan = parsePlan(input.plan);
    if (input.async !== undefined && typeof input.async !== "boolean")
      throw Error(ERRORS.INVALID_PLAN);
    validateExecution(plan);
    this.admit(exec);
    const executor = this.executor(exec);
    const run = executor.createRun(sessionId, plan, {
      ownerPid: process.pid,
      ownerProcess: PROCESS_ID,
    });
    const detached = background === true || input.async === true;
    const promise = this.start(run, executor, exec, false, detached);
    if (detached) return { runId: run.runId, state: "running" };
    return summary(await promise);
  }

  status(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const sessionId = this.sessionId(exec);
    const input = plain(raw, STATUS_KEYS);
    if (input.runId === undefined) {
      const limit = pageNumber(input.limit, 20, 100);
      if (limit === 0) throw Error(ERRORS.INVALID_PLAN);
      const offset = pageNumber(input.offset, 0, 10_000);
      const volatile = [
        ...this.manager.failures.values(),
        ...[...this.manager.active.values()].map((e) => e.run),
      ].filter((run) => run.ownerSessionId === sessionId);
      const records = new Map(
        this.store
          .list(offset + limit + volatile.length, sessionId)
          .map((run) => [run.runId, run]),
      );
      for (const run of volatile) records.set(run.runId, run);
      return {
        runs: [...records.values()]
          .sort(
            (a, b) =>
              b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId),
          )
          .slice(offset, offset + limit)
          .map((run) => ({
            runId: run.runId,
            state: run.state,
            ...(run.goal === undefined ? {} : { goal: run.goal }),
            ...(run.error === undefined ? {} : { error: run.error }),
            updatedAt: run.updatedAt,
            stepCount: run.steps.length,
            progress: runProgress(run),
            guidance: runGuidance(run),
          })),
        diagnostics: this.store.diagnostics(),
      };
    }
    if (input.limit !== undefined || input.offset !== undefined)
      throw Error(ERRORS.INVALID_PLAN);
    return summary(this.owned(input.runId, sessionId));
  }

  result(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const input = plain(raw, RUN_ID_KEYS);
    const run = this.owned(input.runId, this.sessionId(exec));
    return {
      ...summary(run),
      results: structuredClone(run.results),
      finished: run.state !== "running" && run.state !== "interrupted",
    };
  }

  cancel(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const input = plain(raw, RUN_ID_KEYS);
    const run = this.owned(input.runId, this.sessionId(exec));
    const entry = this.manager.active.get(run.runId);
    if (entry) {
      try {
        entry.executor.cancel(entry.run);
      } catch {
        this.rememberStorageFailure(entry.run);
        throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
      } finally {
        entry.controller.abort();
      }
    } else {
      if (run.state === "running") throw Error(ERRORS.RUNTIME_BUSY);
      try {
        this.executor(exec).cancel(run);
      } catch {
        this.rememberStorageFailure(run);
        throw Error(ERRORS.RUNTIME_STORAGE_FAILED);
      }
      try {
        this.store.prune(100);
      } catch {
        /* Retention failures do not reverse cancellation. */
      }
    }
    // Scheduling cancellation is not confirmation that an uncooperative tool stopped.
    return summary(run);
  }

  async resume(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const input = plain(raw, RUN_ID_KEYS);
    const run = this.owned(input.runId, this.sessionId(exec));
    if (run.state !== "interrupted" || this.manager.active.has(run.runId))
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    validateExecution(run.plan);
    this.admit(exec);
    return summary(
      await this.start(run, this.executor(exec), exec, true, false),
    );
  }

  private start(
    run: RunRecord,
    executor: RuntimeExecutor,
    exec: ToolRunContext,
    resume: boolean,
    detached: boolean,
  ): Promise<RunRecord> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (!detached)
      exec.signal?.addEventListener("abort", onAbort, { once: true });
    run.ownerPid = process.pid;
    run.ownerProcess = PROCESS_ID;
    const entry: ActiveRun = {
      owner: this,
      run,
      executor,
      controller,
      promise: undefined!,
    };
    // Register before arbitrary host code, including synchronous re-entrancy.
    this.manager.active.set(run.runId, entry);
    const promise = Promise.resolve()
      .then(() => {
        if (exec.signal?.aborted && !detached) controller.abort();
        this.store.save(run);
        if (run.state === "cancelled") return run;
        return resume
          ? executor.resume(run, controller.signal)
          : executor.execute(run, controller.signal);
      })
      .catch((error: unknown) => {
        run.state = "failed";
        run.error =
          error instanceof Error &&
          error.message === ERRORS.RUNTIME_STORAGE_FAILED
            ? ERRORS.RUNTIME_STORAGE_FAILED
            : ERRORS.RUNTIME_STEP_FAILED;
        run.finishedAt = run.updatedAt = Math.max(
          Date.now(),
          run.updatedAt,
          run.createdAt,
          run.finishedAt ?? 0,
          ...run.steps.flatMap((step) => [
            step.startedAt ?? 0,
            step.finishedAt ?? 0,
          ]),
        );
        try {
          this.store.save(run);
        } catch {
          this.rememberStorageFailure(run);
        }
        throw error;
      })
      .finally(() => {
        exec.signal?.removeEventListener("abort", onAbort);
        if (this.manager.active.get(run.runId) === entry)
          this.manager.active.delete(run.runId);
        try {
          this.store.prune(100);
        } catch {
          /* Cleanup failure cannot reverse a completed operation. */
        }
        this.releaseManager();
      });
    entry.promise = promise;
    void promise.catch(() => {});
    return promise;
  }

  private rememberStorageFailure(run: RunRecord) {
    run.state = "failed";
    run.error = ERRORS.RUNTIME_STORAGE_FAILED;
    run.finishedAt = run.updatedAt = Math.max(
      Date.now(),
      run.updatedAt,
      run.createdAt,
      run.finishedAt ?? 0,
      ...run.steps.flatMap((step) => [
        step.startedAt ?? 0,
        step.finishedAt ?? 0,
      ]),
    );
    this.manager.failures.set(run.runId, run);
    if (this.manager.failures.size > 100)
      this.manager.failures.delete(this.manager.failures.keys().next().value!);
  }
  private releaseManager() {
    if (
      this.manager.references === 0 &&
      this.manager.active.size === 0 &&
      managers.get(this.key) === this.manager
    )
      managers.delete(this.key);
  }
  private ensureOpen() {
    if (this.closed) throw Error(ERRORS.CLOSED);
  }
  private admit(exec: ToolRunContext) {
    if (exec.signal?.aborted) throw Error(ERRORS.RUNTIME_CANCELLED);
    if (this.manager.active.size >= MAX_ACTIVE_RUNS)
      throw Error(ERRORS.RUNTIME_BUSY);
  }
  private sessionId(exec: ToolRunContext): string {
    if (!exec.agent || !String(exec.agent.id ?? ""))
      throw Error(ERRORS.OWNING_SESSION_REQUIRED);
    return String(exec.agent.id);
  }
  private owned(runId: unknown, sessionId: string): RunRecord {
    if (typeof runId !== "string") throw Error(ERRORS.RUNTIME_NOT_FOUND);
    const run =
      this.manager.active.get(runId)?.run ??
      this.manager.failures.get(runId) ??
      this.store.load(runId);
    if (!run || run.ownerSessionId !== sessionId)
      throw Error(ERRORS.RUNTIME_NOT_FOUND);
    return run;
  }
  private executor(exec: ToolRunContext): RuntimeExecutor {
    const invoke: Invoke = async (tool, input, signal) => {
      const result = await this.ctx.tools.execute({
        name: tool,
        callId: (String(exec.callId) +
          ":runtime:" +
          randomUUID()) as typeof exec.callId,
        rootCallId: exec.rootCallId,
        parent: exec.token,
        agent: exec.agent,
        arguments: input,
        signal,
      });
      if (result.isError) throw Error(ERRORS.RUNTIME_STEP_FAILED);
      if (tool === "pwsh") {
        const value = result.value as Record<string, unknown> | null;
        if (value?.kind === "background" || value?.kind === "promoted") {
          throw Object.assign(Error(ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED), {
            result: { kind: value.kind, jobId: value.jobId },
          });
        }
        const sandbox = value?.sandbox as
          | { denied?: boolean; runnerFailed?: boolean }
          | undefined;
        if (value?.timedOut) throw Error(ERRORS.RUNTIME_STEP_TIMEOUT);
        if (value?.aborted || value?.signal || value?.stopped)
          throw Object.assign(Error(ERRORS.RUNTIME_COMMAND_FAILED), {
            unknownSideEffect: true,
          });
        if (
          !value ||
          value.exitCode !== 0 ||
          value.aborted ||
          value.timedOut ||
          value.signal ||
          value.stopped ||
          sandbox?.denied ||
          sandbox?.runnerFailed
        )
          throw Error(ERRORS.RUNTIME_COMMAND_FAILED);
      }
      return result.value;
    };
    return new RuntimeExecutor(this.store, invoke);
  }
}
