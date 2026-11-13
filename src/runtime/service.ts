import { randomUUID, createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import {
  createHandoffSnapshot,
  parseHandoffInput,
  parseHandoffSnapshot,
  verifyHandoffSelections,
} from "./handoff.js";
import { runAction } from "./action.js";
import { HistoryPages } from "./history.js";
import { parseQuery, queryRuns } from "./query.js";
import { comparePlans } from "./plan-diff.js";
import type { PlanChanges } from "./plan-diff.js";
import { NotificationStore } from "./notifications.js";
import { deliverNotification } from "./notification-delivery.js";
import type { NotificationSender } from "./notification-delivery.js";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import { executeHostTool } from "./host-compat.js";
import { ERRORS } from "../error-codes.js";
import { runProgress, runGuidance } from "../presentation.js";
import type { RunProgress, RunGuidance } from "../presentation.js";
import { RuntimeExecutor } from "./executor.js";
import type { Invoke } from "./executor.js";
import { parsePlan, RUNTIME_LIMITS } from "./plan.js";
import { runAcceptance, runRecovery } from "./insights.js";
import { runAttention } from "./attention.js";
import type { RunAttention } from "./attention.js";
import { runWaiting } from "./waiting.js";
import { ownerReview } from "./review.js";
import { decisionLedger, validDecisionInput } from "./decision.js";
import type { DecisionInput } from "./decision.js";
import type { RunRecovery } from "./insights.js";
import { executeAgent } from "./agent.js";
import type { DelegationPolicyAdapter, WorkerHostOptions } from "./agent.js";
import { WorkerQuota } from "./worker-quota.js";
import type { Plan } from "./plan.js";
import { RunStore } from "./store.js";
import { acquireRootLock } from "./root-lock.js";
import type { RunRecord, StepRecord } from "./store.js";

type RunWaiting = ReturnType<typeof runWaiting>;

export type PlanComparison =
  | { comparable: true; changes: PlanChanges }
  | {
      comparable: false;
      reason:
        | "no_previous_run"
        | "predecessor_unavailable"
        | "incompatible_predecessor";
    };

const MAX_ACTIVE_RUNS = 8;
const PROCESS_ID = randomUUID();
const RUN_KEYS = new Set(["plan", "async"]);
const RUN_ID_KEYS = new Set(["runId"]);
const RESULT_KEYS = new Set(["runId", "stepId", "offset", "limit", "hash"]);
// Process-local settlement knowledge only; never infer cleanup after a restart.
const settlement = new Map<string, boolean>();
function observeSettlement(runId: string, done: boolean): void {
  settlement.delete(runId);
  settlement.set(runId, done);
  while (settlement.size > 1024)
    settlement.delete(settlement.keys().next().value!);
}
const STATUS_KEYS = new Set(["runId", "limit", "offset", "snapshot", "cursor"]);
interface ActiveRun {
  owner: RuntimeService;
  run: RunRecord;
  executor: RuntimeExecutor;
  controller: AbortController;
  promise: Promise<RunRecord>;
}
interface RunManager {
  releaseRoot: () => void;
  workerQuota: WorkerQuota;
  active: Map<string, ActiveRun>;
  failures: Map<string, RunRecord>;
  references: number;
}
// Shared only inside this module/process. A new Agent scope is not a process restart.
const managers = new Map<string, RunManager>();

/** Trusted host observation only; never registered as a model tool or a reservation. */
export interface CapacitySnapshot {
  scope: "module_process_root";
  observedAt: number;
  occupiedRuns: number;
  executingRuns: number;
  cleanupRuns: number;
  runLimit: number;
  workersInUse: number;
  workerLimit: number;
}

export interface RunSummary {
  runId: string;
  state: RunRecord["state"];
  goal?: string;
  provenance?: Plan["provenance"];
  taskId?: string;
  previousRunId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  durationMs: number;
  executionSettled?: boolean;
  progress: RunProgress;
  guidance: RunGuidance[];
  recovery: RunRecovery;
  attention: RunAttention;
  decisionLedger: ReturnType<typeof decisionLedger>;
  waiting: RunWaiting;
  ownerReview: ReturnType<typeof ownerReview>;
  action: ReturnType<typeof runAction>;
  steps: Array<{
    id: string;
    tool: string;
    state: StepRecord["state"];
    attempts: number;
    childSessionId?: string;
    workerTrace?: StepRecord["workerTrace"];
    error?: string;
  }>;
}
function summary(run: RunRecord): RunSummary {
  return {
    runId: run.runId,
    state: run.state,
    ...(run.goal === undefined ? {} : { goal: run.goal }),
    ...(run.plan.provenance === undefined
      ? {}
      : { provenance: structuredClone(run.plan.provenance) }),
    ...(run.plan.taskId === undefined ? {} : { taskId: run.plan.taskId }),
    ...(run.plan.previousRunId === undefined
      ? {}
      : { previousRunId: run.plan.previousRunId }),
    ...(run.error === undefined ? {} : { error: run.error }),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    durationMs: Math.max(0, (run.finishedAt ?? Date.now()) - run.createdAt),
    ...(settlement.has(run.runId)
      ? { executionSettled: settlement.get(run.runId)! }
      : {}),
    progress: runProgress(run),
    guidance: runGuidance(run),
    recovery: runRecovery(run, settlement.get(run.runId)),
    attention: runAttention(run, settlement.get(run.runId)),
    decisionLedger: decisionLedger(
      run,
      runAttention(run, settlement.get(run.runId)),
    ),
    waiting: runWaiting(run, settlement.get(run.runId)),
    ownerReview: ownerReview(run),
    action: runAction(run, settlement.get(run.runId)),
    steps: run.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      state: step.state,
      attempts: step.attempts,
      ...(step.childSessionId === undefined
        ? {}
        : { childSessionId: step.childSessionId }),
      ...(step.workerTrace === undefined
        ? {}
        : { workerTrace: structuredClone(step.workerTrace) }),
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
  private readonly history = new HistoryPages();
  private readonly store: RunStore;
  private readonly notifications: NotificationStore;
  private readonly key: string;
  private readonly manager: RunManager;
  private closed = false;
  private disposal?: Promise<void>;

  constructor(
    private readonly ctx: Context,
    store?: RunStore,
    private readonly delegationPolicy?: DelegationPolicyAdapter,
    private readonly workerHostOptions?: WorkerHostOptions,
  ) {
    this.store = store ?? new RunStore();
    const root = realpathSync(this.store.root);
    this.key = process.platform === "win32" ? root.toLowerCase() : root;
    const existing = managers.get(this.key);
    const manager: RunManager = existing ?? {
      releaseRoot: acquireRootLock(root),
      workerQuota: new WorkerQuota(),
      active: new Map(),
      failures: new Map(),
      references: 0,
    };
    // Publish before initialization for synchronous re-entry; every initialization
    // write/maintenance is behind the root lock, including notification setup.
    managers.set(this.key, manager);
    manager.references++;
    this.manager = manager;
    try {
      this.notifications = new NotificationStore(
        path.join(root, "notifications"),
      );
      this.store.maintain(new Set(manager.active.keys()), 100);
    } catch (error) {
      manager.references--;
      this.releaseManager();
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true;
    this.history.clear();
    const own = [...this.manager.active.values()].filter(
      (entry) => entry.owner === this,
    );
    // Cancel and abort synchronously: a host that drops the returned promise
    // or tears the process down right after dispose() still stops scheduling
    // and gets terminal checkpoints. Only the settlement await stays async.
    for (const entry of own) {
      try {
        entry.executor.cancel(entry.run);
      } catch {
        this.rememberStorageFailure(entry.run);
      } finally {
        entry.controller.abort();
      }
    }
    this.disposal = (async () => {
      await Promise.allSettled(own.map((entry) => entry.promise));
      this.manager.references--;
      this.releaseManager();
    })();
    return this.disposal;
  }

  /** Host-only aggregate of this module/process and canonical root. No paths, IDs or IO.
   * Executing includes admitted resume initialization (still interrupted).
   * Cleanup means a terminal run whose owned execution has not settled; it is not
   * proof that ordinary host calls or background Jobs have exited. */
  capacity(): CapacitySnapshot {
    this.ensureOpen();
    const occupiedRuns = this.manager.active.size;
    const executingRuns = [...this.manager.active.values()].filter(
      (entry) =>
        entry.run.state === "running" || entry.run.state === "interrupted",
    ).length;
    return {
      scope: "module_process_root",
      observedAt: Date.now(),
      occupiedRuns,
      executingRuns,
      cleanupRuns: occupiedRuns - executingRuns,
      runLimit: MAX_ACTIVE_RUNS,
      workersInUse: this.manager.workerQuota.activeCount,
      workerLimit: 8,
    };
  }

  /** Descriptive only: no policy checks, tool dispatch, capacity reservation or run creation. */
  capabilities(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    this.sessionId(exec);
    plain(raw, new Set());
    const adapter =
      typeof this.delegationPolicy?.checkParentPolicy === "function";
    const parentAdmission = exec.toolSet !== undefined;
    return {
      ordinaryDag: "supported" as const,
      worker:
        adapter && parentAdmission
          ? ("conditional" as const)
          : ("unavailable" as const),
      workerReason: !adapter
        ? ("trusted_adapter_missing" as const)
        : !parentAdmission
          ? ("parent_admission_missing" as const)
          : ("execution_checks_required" as const),
      ordinaryAsync: !parentAdmission,
      workerAsync: false as const,
      workerTools: ["read", "glob", "grep"],
      limits: {
        maxSteps: RUNTIME_LIMITS.steps,
        maxConcurrency: RUNTIME_LIMITS.concurrencyMax,
        maxActiveRuns: MAX_ACTIVE_RUNS,
        maxWorkers: 8,
      },
      // Coarse shared run admission only: do not expose other owners or counts.
      capacity: {
        scope: "module_process_root" as const,
        observedAt: Date.now(),
        capacityBusy: this.manager.active.size >= MAX_ACTIVE_RUNS,
      },
      authorization: "checked_at_execution" as const,
      message:
        "能力说明不代表授权、工具/模型可用或容量预留；capacityBusy 仅为同模块/进程/运行根目录的运行准入繁忙瞬时观察，false 不保证有空槽或执行成功，不涵盖普通宿主调用/后台 Job 的实际存活。每次执行仍须通过宿主准入。Worker 需要可信父策略适配器及有效父 toolSet；普通异步调用仅适用于无 toolSet 的受控宿主集成。",
    };
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
    // Step admission closes when the outer call returns. Never detach a worker
    // with a dead parent toolSet or synthesize a broader replacement admission.
    if (
      (background || input.async === true) &&
      plan.steps.some((step) => step.tool === "agent")
    )
      throw Error(ERRORS.RUNTIME_AGENT_ASYNC_UNSUPPORTED);
    // Ordinary nested tools also lose their step admission after detaching.
    // Do not drop or re-resolve it to synthesize broader host permissions.
    if ((background || input.async === true) && exec.toolSet !== undefined)
      throw Error(ERRORS.RUNTIME_ASYNC_ADMISSION_UNSUPPORTED);
    if (plan.handoff !== undefined) this.validateHandoff(plan, sessionId);
    if (plan.previousRunId !== undefined) {
      const previous = this.owned(plan.previousRunId, sessionId);
      if (
        previous.plan.taskId !== plan.taskId ||
        !["succeeded", "failed", "cancelled"].includes(previous.state) ||
        this.manager.active.has(previous.runId)
      )
        throw Error(ERRORS.RUNTIME_TASK_LINK_INVALID);
    }
    if (
      plan.steps.some((step) => step.tool === "agent") &&
      typeof this.delegationPolicy?.checkParentPolicy !== "function"
    )
      throw Error(ERRORS.RUNTIME_AGENT_POLICY_UNSUPPORTED);
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

  /** Owner-scoped metadata search. Never dispatches tools or indexes payload text. */
  query(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const owner = this.sessionId(exec);
    const input = parseQuery(raw);
    // Reject overflow before filtering: a rare old action must never silently
    // disappear behind a recent-window limit. Existing storage scan semantics apply.
    const records = new Map(
      this.store
        .list(1001, owner, 0, undefined, true)
        .map((run) => [run.runId, run]),
    );
    for (const run of [
      ...this.manager.failures.values(),
      ...[...this.manager.active.values()].map((entry) => entry.run),
    ]) {
      if (run.ownerSessionId === owner) records.set(run.runId, run);
    }
    if (records.size > 1000) throw Error(ERRORS.RUNTIME_INVALID_STATE);
    const result = queryRuns([...records.values()], input, (id) =>
      settlement.get(id),
    );
    return {
      kind: "owner_metadata_query" as const,
      runs: result.runs.map((run) => ({
        runId: run.runId,
        state: run.state,
        ...(run.goal === undefined ? {} : { goal: run.goal }),
        ...(run.plan.provenance === undefined
          ? {}
          : { provenance: structuredClone(run.plan.provenance) }),
        ...(run.plan.taskId === undefined ? {} : { taskId: run.plan.taskId }),
        ...(run.plan.previousRunId === undefined
          ? {}
          : { previousRunId: run.plan.previousRunId }),
        updatedAt: run.updatedAt,
        stepCount: run.steps.length,
        action: runAction(run, settlement.get(run.runId)),
      })),
      view: input.view,
      offset: input.offset,
      limit: input.limit,
      matchedCount: result.matchedCount,
      groups: result.groups,
      hasMore: result.hasMore,
      scope: "retained_owner_runs" as const,
      order: "updatedAt_desc_runId_asc" as const,
      observedAt: Date.now(),
      scannedCount: records.size,
      scanLimit: 1000,
      diagnostics: this.store.diagnostics(),
      message:
        "仅当前owner可读取的保留运行元数据，先筛选后分页；最多1000条候选，超限拒绝而非截取近期记录。groups为其他条件筛选后、view筛选前的互斥运行数；matchedCount为view筛选后运行数，均非事项数。每次查询实时重算，offset翻页不冻结成员；损坏/不可读记录见diagnostics，空结果不证明没有待办。不是全量历史、授权或验收，不搜索原始结果/输入，不自动执行、恢复或投递。",
    };
  }

  status(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const sessionId = this.sessionId(exec);
    const input = plain(raw, STATUS_KEYS);
    if (input.runId === undefined) {
      if (input.snapshot !== undefined || input.cursor !== undefined)
        return this.historyPage(input, sessionId);
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
            ...(run.plan.provenance === undefined
              ? {}
              : { provenance: structuredClone(run.plan.provenance) }),
            ...(run.plan.taskId === undefined
              ? {}
              : { taskId: run.plan.taskId }),
            ...(run.plan.previousRunId === undefined
              ? {}
              : { previousRunId: run.plan.previousRunId }),
            ...(run.error === undefined ? {} : { error: run.error }),
            updatedAt: run.updatedAt,
            stepCount: run.steps.length,
            progress: runProgress(run),
            guidance: runGuidance(run),
            attention: runAttention(run, settlement.get(run.runId)),
            decisionLedger: decisionLedger(
              run,
              runAttention(run, settlement.get(run.runId)),
            ),
            waiting: runWaiting(run, settlement.get(run.runId)),
            ownerReview: ownerReview(run),
            action: runAction(run, settlement.get(run.runId)),
          })),
        diagnostics: this.store.diagnostics(),
      };
    }
    if (
      input.limit !== undefined ||
      input.offset !== undefined ||
      input.snapshot !== undefined ||
      input.cursor !== undefined
    )
      throw Error(ERRORS.INVALID_PLAN);
    return summary(this.owned(input.runId, sessionId));
  }

  /** Read-only task page over retained owned records; never a claim of complete history. */
  task(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const input = plain(
      raw,
      new Set(["taskId", "limit", "offset", "snapshot", "cursor"]),
    );
    const owner = this.sessionId(exec);
    if (
      typeof input.taskId !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.taskId)
    )
      throw Error(ERRORS.INVALID_PLAN);
    if (input.snapshot !== undefined || input.cursor !== undefined)
      return this.historyPage(input, owner, input.taskId);
    const limit = pageNumber(input.limit, 20, 100);
    const offset = pageNumber(input.offset, 0, 10_000);
    if (!limit) throw Error(ERRORS.INVALID_PLAN);
    const volatile = [
      ...this.manager.failures.values(),
      ...[...this.manager.active.values()].map((e) => e.run),
    ].filter(
      (run) => run.ownerSessionId === owner && run.plan.taskId === input.taskId,
    );
    const records = new Map(
      this.store
        .list(offset + limit + volatile.length + 1, owner, 0, input.taskId)
        .map((run) => [run.runId, run]),
    );
    for (const run of volatile) records.set(run.runId, run);
    const ordered = [...records.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId),
    );
    const runs = ordered
      .slice(offset, offset + limit)
      .map((run) => summary(run));
    return {
      taskId: input.taskId,
      runs,
      offset,
      limit,
      hasMore: ordered.length > offset + limit,
      scope: "retained_owner_runs" as const,
      order: "updatedAt_desc_runId_asc" as const,
      page: {
        runCount: runs.length,
        activeCount: runs.filter((run) => run.state === "running").length,
        attentionCount: runs.reduce(
          (count, run) =>
            count +
            run.attention.items.filter(
              (item) =>
                (!item.acknowledged ||
                  item.kind === "inspect_external_state") &&
                !(item.kind === "decision_required" && item.disposition),
            ).length,
          0,
        ),
        reviewCount: runs.filter(
          (run) =>
            run.ownerReview.status !== "accepted" &&
            run.attention.items.some((item) => item.kind === "review_results"),
        ).length,
      },
      diagnostics: this.store.diagnostics(),
      message:
        "仅当前owner保留记录的本页汇总，按活动时间排序；历史可能已清理，非全量历史或交付/独立验收结论。previousRunId仅为关联，前驱可能不在本页。结果请按runId用runtime_result读取。",
    };
  }

  /** Freeze membership/order only. Re-read each owned record so actions never use stale state. */
  private historyPage(
    input: Record<string, unknown>,
    owner: string,
    taskId?: string,
  ) {
    if (input.offset !== undefined) throw Error(ERRORS.INVALID_PLAN);
    const page = this.history.page(owner, taskId, input, () => {
      const records = new Map(
        this.store
          .list(1001, owner, 0, taskId, true)
          .map((run) => [run.runId, run]),
      );
      for (const run of [
        ...this.manager.failures.values(),
        ...[...this.manager.active.values()].map((entry) => entry.run),
      ]) {
        if (
          run.ownerSessionId === owner &&
          (taskId === undefined || run.plan.taskId === taskId)
        )
          records.set(run.runId, run);
      }
      return [...records.values()]
        .sort(
          (a, b) => b.updatedAt - a.updatedAt || a.runId.localeCompare(b.runId),
        )
        .map((run) => run.runId);
    });
    const runs: RunSummary[] = [];
    for (const id of page.ids) {
      const run =
        this.manager.failures.get(id) ??
        this.manager.active.get(id)?.run ??
        this.store.load(id);
      if (
        !run ||
        run.ownerSessionId !== owner ||
        (taskId !== undefined && run.plan.taskId !== taskId)
      )
        page.pagination.missingRunIds.push(id);
      else runs.push(summary(run));
    }
    return {
      ...(taskId === undefined ? {} : { taskId }),
      runs,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.hasMore,
      scope: "retained_owner_runs" as const,
      order: "snapshot_membership" as const,
      pagination: page.pagination,
      page: {
        runCount: runs.length,
        activeCount: runs.filter((run) => run.state === "running").length,
        attentionCount: runs.reduce(
          (n, run) =>
            n +
            run.attention.items.filter(
              (item) =>
                (!item.acknowledged ||
                  item.kind === "inspect_external_state") &&
                !(item.kind === "decision_required" && item.disposition),
            ).length,
          0,
        ),
        reviewCount: runs.filter(
          (run) =>
            run.ownerReview.status !== "accepted" &&
            run.attention.items.some((item) => item.kind === "review_results"),
        ).length,
      },
      diagnostics: this.store.diagnostics(),
      message:
        "固定本次捕获的保留运行成员及顺序，状态实时重读；不是完整历史或状态快照。新增运行不插入本快照；缺失/已清理项列于missingRunIds，不自动补位。快照5分钟有效，当前服务销毁、重启或容量淘汰后失效，请重新snapshot:true；不要与最近活动页直接拼接。",
    };
  }

  /** Host-only, explicit delivery using the original owner's context. Not a model tool. */
  deliverNotification(
    runId: string,
    exec: ToolRunContext,
    sender: NotificationSender,
  ) {
    this.ensureOpen();
    if (typeof sender !== "function") throw Error(ERRORS.INVALID_PLAN);
    return deliverNotification(
      (input) => this.notification(input, exec),
      () => {
        const run = this.owned(runId, this.sessionId(exec));
        const action = runAction(run, settlement.get(run.runId));
        return [
          "萧何运行待办",
          "运行：" + run.runId,
          "当前行动（" + action.actor + "）：" + action.message,
          "只读定位：runtime_result(" + JSON.stringify({ runId }) + ")",
          "通知不表示问题已解决、业务交付或独立验收。",
        ].join("\n");
      },
      runId,
      sender,
      exec.signal,
    );
  }

  /** Explicit receipt protocol only. No sender, timer, replay, or DAG invocation. */
  notification(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const input = plain(
      raw,
      new Set([
        "runId",
        "operation",
        "key",
        "expectedRevision",
        "attemptToken",
        "outcome",
      ]),
    );
    const owner = this.sessionId(exec);
    const run = this.owned(input.runId, owner);
    const operation = input.operation === undefined ? "get" : input.operation;
    if (!["get", "sync", "claim", "settle"].includes(operation as string))
      throw Error(ERRORS.INVALID_PLAN);
    if (operation === "get" || operation === "sync") {
      if (
        [
          input.key,
          input.expectedRevision,
          input.attemptToken,
          input.outcome,
        ].some((v) => v !== undefined)
      )
        throw Error(ERRORS.INVALID_PLAN);
    } else {
      if (
        typeof input.key !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.key) ||
        !Number.isSafeInteger(input.expectedRevision) ||
        (input.expectedRevision as number) < 0
      )
        throw Error(ERRORS.INVALID_PLAN);
      if (
        operation === "claim" &&
        (input.attemptToken !== undefined || input.outcome !== undefined)
      )
        throw Error(ERRORS.INVALID_PLAN);
      if (
        operation === "settle" &&
        (typeof input.attemptToken !== "string" ||
          !["sent", "failed"].includes(input.outcome as string))
      )
        throw Error(ERRORS.INVALID_PLAN);
    }
    if (operation !== "get" && exec.signal?.aborted)
      throw Error(ERRORS.RUNTIME_CANCELLED);
    const attention = runAttention(run, settlement.get(run.runId));
    // Delivery versions also bind the problem snapshot: a later occurrence of the
    // same action must not be suppressed by a prior sent/withdrawn receipt.
    const current = {
      key: createHash("sha256")
        .update(
          JSON.stringify([attention.notification.key, attention.snapshotHash]),
        )
        .digest("hex"),
      shouldNotify: attention.notification.shouldNotify,
    };
    let receipt;
    if (operation === "get") receipt = this.notifications.get(owner, run.runId);
    else {
      // Reconcile immediately before a claim/callback: an obsolete payload cannot settle a newer version.
      receipt = this.notifications.sync(
        owner,
        run.runId,
        current.key,
        current.shouldNotify,
      );
      if (operation === "claim") {
        if (!current.shouldNotify || input.key !== current.key)
          throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
        receipt = this.notifications.claim(
          owner,
          run.runId,
          input.key as string,
          input.expectedRevision as number,
        );
      } else if (operation === "settle") {
        if (!current.shouldNotify || input.key !== current.key)
          throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
        receipt = this.notifications.settle(
          owner,
          run.runId,
          input.key as string,
          input.expectedRevision as number,
          input.attemptToken as string,
          input.outcome as "sent" | "failed",
        );
      }
    }
    return {
      runId: run.runId,
      current,
      ...(receipt === undefined ? {} : { receipt }),
      verification: "owner_declared_not_delivery_verified" as const,
      message:
        "仅通知投递回执协议；sync合并当前事项，claim后由宿主显式投递，settle记录投递方声明。不会自动发送/重试或重跑DAG；sent不证明已阅读、处理、交付或验收。delivering崩溃后须核验渠道，不自动重发。",
    };
  }

  acknowledge(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const sessionId = this.sessionId(exec);
    const input = plain(
      raw,
      new Set(["runId", "snapshotHash", "key", "expectedRevision", "reason"]),
    );
    const run = this.owned(input.runId, sessionId);
    if (exec.signal?.aborted) throw Error(ERRORS.RUNTIME_CANCELLED);
    if (
      this.manager.active.has(run.runId) ||
      this.manager.failures.has(run.runId) ||
      run.state === "running" ||
      run.state === "interrupted"
    )
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    if (
      typeof input.snapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.snapshotHash) ||
      typeof input.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.key) ||
      typeof input.expectedRevision !== "number" ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      Buffer.byteLength(input.reason, "utf8") > 2048
    )
      throw Error(ERRORS.INVALID_PLAN);
    const saved = this.store.recordAcknowledgement(run.runId, sessionId, {
      snapshotHash: input.snapshotHash,
      key: input.key,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
    });
    return {
      ...summary(saved),
      acknowledgementHistory: saved.acknowledgements!,
    };
  }

  decision(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const sessionId = this.sessionId(exec);
    const input = plain(
      raw,
      new Set([
        "runId",
        "snapshotHash",
        "key",
        "expectedRevision",
        "disposition",
        "reason",
        "answer_ref",
        "successor_run_id",
      ]),
    );
    const run = this.owned(input.runId, sessionId);
    if (exec.signal?.aborted) throw Error(ERRORS.RUNTIME_CANCELLED);
    if (
      this.manager.active.has(run.runId) ||
      this.manager.failures.has(run.runId) ||
      run.state === "running" ||
      run.state === "interrupted"
    )
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    const declaration = {
      snapshotHash: input.snapshotHash,
      key: input.key,
      expectedRevision: input.expectedRevision,
      disposition: input.disposition,
      reason: input.reason,
      ...(input.answer_ref === undefined
        ? {}
        : { answerRef: input.answer_ref }),
      ...(input.successor_run_id === undefined
        ? {}
        : { successorRunId: input.successor_run_id }),
    } as DecisionInput;
    if (!validDecisionInput(declaration)) throw Error(ERRORS.INVALID_PLAN);
    const saved = this.store.recordDecision(run.runId, sessionId, declaration);
    return { ...summary(saved), decisionHistory: saved.decisionDispositions! };
  }

  review(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const sessionId = this.sessionId(exec);
    const input = plain(
      raw,
      new Set([
        "runId",
        "snapshotHash",
        "expectedRevision",
        "disposition",
        "reason",
      ]),
    );
    const run = this.owned(input.runId, sessionId);
    if (exec.signal?.aborted) throw Error(ERRORS.RUNTIME_CANCELLED);
    if (
      this.manager.active.has(run.runId) ||
      this.manager.failures.has(run.runId)
    )
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    if (
      typeof input.snapshotHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.snapshotHash) ||
      typeof input.expectedRevision !== "number" ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      (input.disposition !== "accepted" &&
        input.disposition !== "needs_work") ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      Buffer.byteLength(input.reason, "utf8") > 2048
    )
      throw Error(ERRORS.INVALID_PLAN);
    const saved = this.store.recordReview(run.runId, sessionId, {
      snapshotHash: input.snapshotHash,
      expectedRevision: input.expectedRevision,
      disposition: input.disposition,
      reason: input.reason,
    });
    return { ...summary(saved), ownerReviewHistory: saved.ownerReviews! };
  }

  result(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const input = plain(raw, RESULT_KEYS);
    const run = this.owned(input.runId, this.sessionId(exec));
    if (input.stepId !== undefined) {
      if (
        typeof input.stepId !== "string" ||
        !run.steps.some((s) => s.id === input.stepId)
      )
        throw Error(ERRORS.RUNTIME_NOT_FOUND);
      const stored = Object.hasOwn(run.results, input.stepId)
        ? run.results[input.stepId]
        : undefined;
      if (!stored || stored.truncated || !Object.hasOwn(stored, "value"))
        throw Error(ERRORS.RUNTIME_RESULT_UNAVAILABLE);
      const text = JSON.stringify(stored.value);
      const hash = createHash("sha256").update(text).digest("hex");
      if (input.hash !== undefined && input.hash !== hash)
        throw Error(ERRORS.RUNTIME_RESULT_CHANGED);
      // Code-point offsets never split surrogate pairs. Each page is <= 16KiB UTF-8.
      const chars = Array.from(text);
      const offset = pageNumber(input.offset, 0, chars.length);
      const limit = pageNumber(input.limit, 2048, 4096);
      if (!limit) throw Error(ERRORS.INVALID_PLAN);
      const end = Math.min(chars.length, offset + limit);
      return {
        ...summary(run),
        acceptance: runAcceptance(run),
        ownerReviewHistory: run.ownerReviews ?? [],
        acknowledgementHistory: run.acknowledgements ?? [],
        decisionHistory: run.decisionDispositions ?? [],
        results: {},
        finished: run.state !== "running" && run.state !== "interrupted",
        page: {
          stepId: input.stepId,
          encoding: "json",
          unit: "unicode_code_point",
          hash,
          offset,
          total: chars.length,
          text: chars.slice(offset, end).join(""),
          ...(end < chars.length ? { nextOffset: end } : {}),
        },
      };
    }
    if (
      input.offset !== undefined ||
      input.limit !== undefined ||
      input.hash !== undefined
    )
      throw Error(ERRORS.INVALID_PLAN);
    return {
      ...summary(run),
      acceptance: runAcceptance(run),
      ownerReviewHistory: run.ownerReviews ?? [],
      acknowledgementHistory: run.acknowledgements ?? [],
      decisionHistory: run.decisionDispositions ?? [],
      ...(run.plan.handoff === undefined
        ? {}
        : { handoff: structuredClone(run.plan.handoff) }),
      planComparison: this.comparePredecessor(run),
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
    if (run.plan.handoff !== undefined)
      this.validateHandoff(run.plan, this.sessionId(exec));
    validateExecution(run.plan);
    if (
      run.plan.steps.some((step) => step.tool === "agent") &&
      typeof this.delegationPolicy?.checkParentPolicy !== "function"
    )
      throw Error(ERRORS.RUNTIME_AGENT_POLICY_UNSUPPORTED);
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
    observeSettlement(run.runId, false);
    const promise = Promise.resolve()
      .then(() => {
        // Recheck source versions after the scheduling boundary, before any dispatch.
        if (run.plan.handoff !== undefined)
          this.validateHandoff(run.plan, run.ownerSessionId);
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
        // Eviction means unknown, never a fabricated cleanup success.
        observeSettlement(run.runId, true);
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
    ) {
      try {
        this.manager.releaseRoot();
      } finally {
        // Failed release keeps the on-disk lock fail-closed; do not reuse an
        // owner that has no references or live work.
        managers.delete(this.key);
      }
    }
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
  /** Full result detail only: no list fan-out, checkpoints, result reuse or authority. */
  private comparePredecessor(run: RunRecord): PlanComparison {
    if (run.plan.previousRunId === undefined)
      return { comparable: false, reason: "no_previous_run" };
    let previous: RunRecord;
    try {
      previous = this.owned(run.plan.previousRunId, run.ownerSessionId);
    } catch {
      // Missing, unreadable, invalid-schema and foreign-owner records are indistinguishable.
      return { comparable: false, reason: "predecessor_unavailable" };
    }
    if (
      previous.runId === run.runId ||
      previous.plan.taskId !== run.plan.taskId ||
      !["succeeded", "failed", "cancelled"].includes(previous.state) ||
      this.manager.active.has(previous.runId)
    )
      return { comparable: false, reason: "incompatible_predecessor" };
    return { comparable: true, changes: comparePlans(previous.plan, run.plan) };
  }

  /** Produce only an owner-authored untrusted snapshot; persistence is in a later plan. */
  handoff(raw: unknown, exec: ToolRunContext) {
    this.ensureOpen();
    const input = parseHandoffInput(raw);
    const source = this.handoffSource(input.runId, this.sessionId(exec));
    return createHandoffSnapshot(input, source);
  }

  private handoffSource(runId: string, owner: string): RunRecord {
    this.owned(runId, owner);
    const source = this.store.load(runId);
    if (!source || source.ownerSessionId !== owner)
      throw Error(ERRORS.RUNTIME_NOT_FOUND);
    if (
      !["succeeded", "failed", "cancelled"].includes(source.state) ||
      this.manager.active.has(runId) ||
      this.manager.failures.has(runId) ||
      settlement.get(runId) !== true ||
      !source.plan.taskId
    )
      throw Error(ERRORS.RUNTIME_INVALID_STATE);
    return source;
  }

  private validateHandoff(plan: Plan, owner: string): void {
    const handoff = parseHandoffSnapshot(plan.handoff);
    if (
      plan.taskId !== handoff.taskId ||
      plan.previousRunId !== handoff.sourceRunId
    )
      throw Error(ERRORS.INVALID_PLAN);
    const source = this.handoffSource(handoff.sourceRunId, owner);
    if (source.plan.taskId !== handoff.taskId) throw Error(ERRORS.INVALID_PLAN);
    verifyHandoffSelections(handoff.selections, source);
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
    const invoke: Invoke = async (tool, input, signal, onCreated, context) => {
      if (tool === "agent") {
        // Reserve before any host creation code, including synchronous re-entry.
        // Never queue or detach workers behind the parent admission lifetime.
        const release = this.manager.workerQuota.reserve();
        try {
          const { trace: _trace, ...result } = await executeAgent(
            this.ctx,
            exec,
            input,
            signal,
            onCreated,
            onCreated,
            this.delegationPolicy,
            this.workerHostOptions,
            context,
          );
          // Audit metadata is already checkpointed in StepRecord. Keep it outside
          // the legacy result quota and dependency prompt to preserve text budgets.
          return result;
        } finally {
          // executeAgent settles only after its awaited handle.dispose(). Neither
          // abort nor RuntimeService.dispose may release this reservation early.
          release();
        }
      }
      const result = await executeHostTool(this.ctx, {
        name: tool,
        callId: (String(exec.callId) +
          ":runtime:" +
          randomUUID()) as typeof exec.callId,
        rootCallId: exec.rootCallId,
        parent: exec.token,
        agent: exec.agent,
        toolSet: exec.toolSet,
        arguments: input,
        signal,
      });
      if (result.isError) {
        // Canonical host error codes only; never inspect content/message or tool values.
        // rc.1 may omit raw status/errno, which cannot safely be reconstructed.
        const error = Error(ERRORS.RUNTIME_STEP_FAILED);
        const code = result.error?.info?.code;
        if (typeof code === "string") Object.assign(error, { code });
        throw error;
      }
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
    return new RuntimeExecutor(
      this.store,
      invoke,
      this.workerHostOptions?.dependencyReader?.toolName,
    );
  }
}
