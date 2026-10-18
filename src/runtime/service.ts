import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { ERRORS } from "../error-codes.js";
import { RuntimeExecutor } from "./executor.js";
import type { Invoke } from "./executor.js";
import { parsePlan } from "./plan.js";
import type { Plan } from "./plan.js";
import { RunStore } from "./store.js";
import type { RunRecord, StepRecord } from "./store.js";

const MAX_ACTIVE_RUNS = 8;
const RUN_KEYS = new Set(["plan", "async"]);
const RUN_ID_KEYS = new Set(["runId"]);

export interface RunSummary {
  runId: string;
  state: RunRecord["state"];
  goal?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  durationMs: number;
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

/** 每个预设作用域一个运行时服务：运行记录落盘、按会话隔离、可取消/恢复。 */
export class RuntimeService {
  private readonly store: RunStore;
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<RunRecord> }
  >();

  constructor(
    private readonly ctx: Context,
    store?: RunStore,
  ) {
    this.store = store ?? new RunStore();
    this.store.markInterrupted();
    this.store.prune(100);
  }

  dispose() {
    for (const entry of this.active.values()) entry.controller.abort();
    this.active.clear();
  }

  async run(
    raw: unknown,
    exec: ToolRunContext,
    background = false,
  ): Promise<RunSummary | { runId: string; state: "running" }> {
    const sessionId = this.sessionId(exec);
    const input = plain(raw, RUN_KEYS);
    const plan = parsePlan(input.plan);
    if (input.async !== undefined && typeof input.async !== "boolean")
      throw Error(ERRORS.INVALID_PLAN);
    if (this.active.size >= MAX_ACTIVE_RUNS) throw Error(ERRORS.RUNTIME_BUSY);
    const executor = this.executor(exec);
    const run = executor.createRun(sessionId, plan);
    const controller = new AbortController();
    const promise = executor
      .execute(run, controller.signal)
      .catch((error: unknown) => {
        run.state = "failed";
        run.error = ERRORS.RUNTIME_STEP_FAILED;
        run.finishedAt = Date.now();
        try {
          this.store.save(run);
        } catch {}
        throw error;
      });
    this.active.set(run.runId, { controller, promise });
    void promise
      .finally(() => this.active.delete(run.runId))
      .catch(() => {});
    if (background === true || input.async === true)
      return { runId: run.runId, state: "running" };
    return summary(await promise);
  }

  status(raw: unknown, exec: ToolRunContext) {
    const sessionId = this.sessionId(exec);
    const input = plain(raw, RUN_ID_KEYS);
    if (input.runId === undefined) {
      return {
        runs: this.store
          .list(20)
          .filter((run) => run.ownerSessionId === sessionId)
          .map((run) => ({
            runId: run.runId,
            state: run.state,
            ...(run.goal === undefined ? {} : { goal: run.goal }),
            updatedAt: run.updatedAt,
            stepCount: run.steps.length,
          })),
      };
    }
    const run = this.owned(input.runId, sessionId);
    return summary(run);
  }

  result(raw: unknown, exec: ToolRunContext) {
    const sessionId = this.sessionId(exec);
    const input = plain(raw, RUN_ID_KEYS);
    if (typeof input.runId !== "string")
      throw Error(ERRORS.RUNTIME_NOT_FOUND);
    const run = this.owned(input.runId, sessionId);
    return {
      ...summary(run),
      results: run.results,
      finished: run.state !== "running" && run.state !== "interrupted",
    };
  }

  cancel(raw: unknown, exec: ToolRunContext) {
    const sessionId = this.sessionId(exec);
    const input = plain(raw, RUN_ID_KEYS);
    if (typeof input.runId !== "string")
      throw Error(ERRORS.RUNTIME_NOT_FOUND);
    const run = this.owned(input.runId, sessionId);
    const active = this.active.get(run.runId);
    if (active) active.controller.abort();
    else this.executor(exec).cancel(run);
    try {
      this.store.save(run);
    } catch {}
    return summary(run);
  }

  async resume(raw: unknown, exec: ToolRunContext) {
    const sessionId = this.sessionId(exec);
    const input = plain(raw, RUN_ID_KEYS);
    if (typeof input.runId !== "string")
      throw Error(ERRORS.RUNTIME_NOT_FOUND);
    const run = this.owned(input.runId, sessionId);
    if (run.state !== "interrupted")
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    const executor = this.executor(exec);
    const controller = new AbortController();
    const promise = executor.resume(run, controller.signal);
    this.active.set(run.runId, { controller, promise });
    void promise
      .finally(() => this.active.delete(run.runId))
      .catch(() => {});
    return summary(await promise);
  }

  private sessionId(exec: ToolRunContext): string {
    if (!exec.agent) throw Error(ERRORS.OWNING_SESSION_REQUIRED);
    return String(exec.agent.id);
  }

  private owned(runId: unknown, sessionId: string): RunRecord {
    if (typeof runId !== "string") throw Error(ERRORS.RUNTIME_NOT_FOUND);
    const run = this.store.load(runId);
    if (!run || run.ownerSessionId !== sessionId)
      throw Error(ERRORS.RUNTIME_NOT_FOUND);
    return run;
  }

  private executor(exec: ToolRunContext): RuntimeExecutor {
    const self = this;
    const invoke: Invoke = async (tool, input, signal) => {
      const result = await self.ctx.tools.execute({
        name: tool,
        callId: (String(exec.callId) + ":runtime:" + randomUUID()) as typeof exec.callId,
        rootCallId: exec.rootCallId,
        parent: exec.token,
        agent: exec.agent,
        arguments: input,
        signal,
      });
      if (result.isError) throw Error(ERRORS.RUNTIME_STEP_FAILED);
      return result.value;
    };
    return new RuntimeExecutor(this.store, invoke);
  }
}
