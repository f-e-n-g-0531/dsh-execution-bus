import type {
  JsonSchemaNode,
  ToolResult,
  ToolResultView,
} from "@deepseek-ai/dsh-tools";
import { ERRORS } from "./error-codes.js";
import { IDEMPOTENT_TOOLS } from "./runtime/plan.js";
import type { RunRecord } from "./runtime/store.js";

export interface RunProgress {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  unknown: number;
}
export interface RunGuidance {
  code: string;
  message: string;
  stepId?: string;
  jobId?: string;
  suggestions?: Array<{ tool: string; input: Record<string, string> }>;
}

/** Derived only after the service selected an owned record; never persisted. */
export function runProgress(run: RunRecord): RunProgress {
  const progress: RunProgress = {
    total: run.steps.length,
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    unknown: 0,
  };
  for (const step of run.steps) progress[step.state]++;
  return progress;
}

/** Advice is not an execution policy, authorization, or proof a Job stopped. */
export function runGuidance(run: RunRecord): RunGuidance[] {
  const guidance: RunGuidance[] = [];
  let unsafeResume = run.steps.some((step) => step.state === "failed");
  for (const step of run.steps) {
    if (step.tool === "agent" && step.state === "succeeded") {
      guidance.push({
        code: "agent_requires_verification",
        stepId: step.id,
        message:
          "Worker 已返回，不代表任务独立验收通过。Lead 必须检查结果与证据；依赖成功仅表示执行完成。",
      });
    }
    const uncertain =
      step.state === "unknown" ||
      (run.state === "interrupted" && step.state === "running");
    const unsafe =
      !IDEMPOTENT_TOOLS.has(step.tool) &&
      (uncertain || step.error === ERRORS.RUNTIME_INTERRUPTED);
    if (unsafe) {
      unsafeResume = true;
      guidance.push({
        code: "unknown_side_effect",
        stepId: step.id,
        message:
          "副作用结果未知，不代表失败、回滚或进程已停止。请先核验外部状态；不要自动重发或用新计划盲目重跑。runtime_resume 不会重放该步骤，并会停止整个恢复计划。",
      });
    } else if (uncertain) {
      guidance.push({
        code: "unknown_read",
        stepId: step.id,
        message:
          "只读步骤结果未确认；interrupted 运行可显式恢复。旧调用可能仍在执行，不要据此假定它已经停止。",
      });
    }
    // Only executor-owned pwsh background receipts are locators. Never scan
    // arbitrary read/grep output for Job IDs, or expose plan inputs/raw values.
    const receipt = run.results[step.id];
    const value = receipt?.value;
    if (
      step.tool === "pwsh" &&
      step.error === ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED
    ) {
      const job = !receipt?.truncated ? object(value) : undefined;
      if (
        (job?.kind === "background" || job?.kind === "promoted") &&
        typeof job.jobId === "string" &&
        job.jobId.trim()
      ) {
        guidance.push({
          code: "background_job",
          stepId: step.id,
          jobId: job.jobId,
          message:
            "宿主命令已转后台，Job 可能仍在运行，依赖步骤未获成功许可。请由原 owner 用 job_output 收集；若决定停止，再显式 job_kill。这里不会自动调用 Job 工具；取消运行也不确认 Job 已停止。",
          suggestions: [
            { tool: "job_output", input: { job_id: job.jobId } },
            { tool: "job_kill", input: { job_id: job.jobId } },
          ],
        });
      } else {
        guidance.push({
          code: "background_job_unlocated",
          stepId: step.id,
          message:
            "后台回执没有可用 jobId。请由原 owner 用 job_list 核实，不要猜测 ID 或重发命令。",
        });
      }
    }
  }
  if (run.state === "interrupted")
    guidance.push({
      code: "interrupted",
      message: unsafeResume
        ? "运行已中断且存在失败步骤或未知副作用；恢复不会绕过这些边界。先核验外部状态与已保存结果，不要自动重跑。"
        : "运行已中断。可显式 runtime_resume：保留已保存成功步骤，只读在途步骤重排；这不是副作用回滚或 exactly-once 保证。",
      ...(!unsafeResume
        ? {
            suggestions: [
              { tool: "runtime_resume", input: { runId: run.runId } },
            ],
          }
        : {}),
    });
  if (
    run.state === "failed" &&
    run.steps.some((step) => step.state === "pending")
  )
    guidance.push({
      code: "pending_not_scheduled",
      message:
        "运行已失败；pending 步骤未获调度或成功确认，不会继续自动执行。不要将待执行计数解读为仍在后台推进。",
    });
  if (run.state === "cancelled")
    guidance.push({
      code: "cancelled",
      message:
        "已停止运行调度并请求取消；这不确认不合作的宿主工具或后台 Job 已停止。",
    });
  if (run.error === ERRORS.RUNTIME_STORAGE_FAILED)
    guidance.push({
      code: "storage_failure",
      message:
        "运行记录保存失败；当前状态可能只在本进程可见，磁盘记录可能落后。请核验实际副作用，不要依赖旧检查点自动重跑。",
    });
  return guidance;
}

const string: JsonSchemaNode = { type: "string" };
const integer: JsonSchemaNode = { type: "integer" };
const runState: JsonSchemaNode = {
  type: "string",
  enum: ["running", "succeeded", "failed", "cancelled", "interrupted"],
};
const stepState: JsonSchemaNode = {
  type: "string",
  enum: ["pending", "running", "succeeded", "failed", "cancelled", "unknown"],
};
const progressSchema: JsonSchemaNode = {
  type: "object",
  properties: Object.fromEntries(
    [
      "total",
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
    ].map((key) => [key, integer]),
  ),
  required: [
    "total",
    "pending",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
  ],
  additionalProperties: false,
};
const guidanceSchema: JsonSchemaNode = {
  type: "array",
  items: {
    type: "object",
    properties: {
      code: string,
      message: string,
      stepId: string,
      jobId: string,
      suggestions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: string,
            input: {
              type: "object",
              properties: { runId: string, job_id: string },
              additionalProperties: false,
            },
          },
          required: ["tool", "input"],
          additionalProperties: false,
        },
      },
    },
    required: ["code", "message"],
    additionalProperties: false,
  },
};
const workerModelSchema: JsonSchemaNode = {
  type: "object",
  properties: { provider: string, model: string, reasoningEffort: string },
  required: ["provider", "model"],
  additionalProperties: false,
};
const workerTraceSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    promptVersion: string,
    promptHash: string,
    taskPromptHash: string,
    outputFormat: { type: "string", enum: ["text", "report"] },
    selectedModel: workerModelSchema,
    requestModels: { type: "array", items: workerModelSchema },
  },
  required: [
    "promptVersion",
    "promptHash",
    "taskPromptHash",
    "outputFormat",
    "selectedModel",
    "requestModels",
  ],
  additionalProperties: false,
};
const attentionSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    snapshotHash: string,
    revision: integer,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: string,
          kind: {
            type: "string",
            enum: [
              "inspect_external_state",
              "inspect_failure",
              "resume_read_only",
              "decision_required",
              "result_unavailable",
              "review_results",
            ],
          },
          stepId: string,
          resultHash: string,
          acknowledged: { type: "boolean", const: true },
          disposition: { type: "string", enum: ["answered", "superseded", "dismissed"] },
        },
        required: ["key", "kind"],
        additionalProperties: false,
      },
    },
    notification: {
      type: "object",
      properties: { key: string, shouldNotify: { type: "boolean" } },
      required: ["key", "shouldNotify"],
      additionalProperties: false,
    },
  },
  required: ["items", "notification"],
  additionalProperties: false,
};
const waitingSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepId: string,
          reason: {
            type: "string",
            enum: ["dependency", "scheduler", "retry_backoff"],
          },
          waitingSince: integer,
          nextRetryAt: integer,
          retryCategory: {
            type: "string",
            enum: [
              "permission",
              "invalid",
              "not_found",
              "transient",
              "deterministic",
              "legacy_unknown",
            ],
          },
          disposition: {
            type: "string",
            enum: ["waiting_retry", "needs_action"],
          },
        },
        required: ["stepId", "reason"],
        additionalProperties: false,
      },
    },
    cleanupPending: { type: "boolean" },
  },
  required: ["steps", "cleanupPending"],
  additionalProperties: false,
};
const recoverySchema: JsonSchemaNode = {
  type: "object",
  properties: {
    resultCertainty: {
      type: "string",
      enum: ["recorded", "incomplete", "unknown"],
    },
    cleanup: { type: "string", enum: ["pending", "settled", "unknown"] },
    externalWork: { type: "string", const: "unconfirmed" },
    nextAction: {
      type: "string",
      enum: [
        "wait",
        "inspect_external_state",
        "resume_read_only",
        "review_results",
        "inspect_failure",
      ],
    },
    message: string,
  },
  required: [
    "resultCertainty",
    "cleanup",
    "externalWork",
    "nextAction",
    "message",
  ],
  additionalProperties: false,
};
const acceptanceSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    status: { type: "string", const: "not_reviewed" },
    workers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          stepId: string,
          state: stepState,
          resultHash: string,
          reportOutcome: {
            type: "string",
            enum: ["completed", "partial", "blocked"],
          },
          criteria: {
            type: "object",
            properties: {
              observed: integer,
              notVerified: integer,
              blocked: integer,
            },
            required: ["observed", "notVerified", "blocked"],
            additionalProperties: false,
          },
          evidenceCount: integer,
          limitationCount: integer,
          decisionRequired: { type: "boolean" },
        },
        required: ["stepId", "state"],
        additionalProperties: false,
      },
    },
  },
  required: ["status", "workers"],
  additionalProperties: false,
};
const decisionDispositionSchema: JsonSchemaNode = { type: "string", enum: ["answered", "superseded", "dismissed"] };
const decisionLedgerSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    revision: integer,
    verification: { type: "string", const: "owner_declared_not_user_approval" },
    items: { type: "array", items: {
      type: "object", properties: {
        key: string, stepId: string, resultHash: string,
        status: { type: "string", enum: ["open", "answered", "superseded", "dismissed"] },
        recordedAt: integer,
      }, required: ["key", "status"], additionalProperties: false,
    } },
  },
  required: ["revision", "verification", "items"], additionalProperties: false,
};
const decisionHistorySchema: JsonSchemaNode = {
  type: "array", items: {
    type: "object", properties: {
      revision: integer, snapshotHash: string, key: string,
      disposition: decisionDispositionSchema, reason: string,
      answerRef: string, successorRunId: string, at: integer,
    }, required: ["revision", "snapshotHash", "key", "disposition", "reason", "at"], additionalProperties: false,
  },
};
const handoffSchema: JsonSchemaNode = {
  type: "object", properties: {
    kind: { type: "string", const: "untrusted_run_handoff" }, sourceRunId: string, taskId: string, summary: string,
    selections: { type: "array", items: { type: "object", properties: { stepId: string, resultHash: string }, required: ["stepId", "resultHash"], additionalProperties: false } },
    snapshotHash: string, authorized: { type: "boolean", const: false }, executable: { type: "boolean", const: false },
  }, required: ["kind", "sourceRunId", "taskId", "summary", "selections", "snapshotHash", "authorized", "executable"], additionalProperties: false,
};
const ownerReviewSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    revision: integer,
    status: {
      type: "string",
      enum: ["not_recorded", "stale", "accepted", "needs_work"],
    },
    verification: {
      type: "string",
      const: "owner_declared_not_independently_verified",
    },
    snapshotHash: string,
    recordedAt: integer,
  },
  required: ["revision", "status", "verification"],
  additionalProperties: false,
};
const ownerReviewHistorySchema: JsonSchemaNode = {
  type: "array",
  items: {
    type: "object",
    properties: {
      revision: integer,
      snapshotHash: string,
      disposition: { type: "string", enum: ["accepted", "needs_work"] },
      reason: string,
      at: integer,
    },
    required: ["revision", "snapshotHash", "disposition", "reason", "at"],
    additionalProperties: false,
  },
};
const actionSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "inspect_external_state",
        "wait_cleanup",
        "inspect_failure",
        "decision_required",
        "result_unavailable",
        "resume_read_only",
        "review_results",
        "wait_retry",
        "working",
        "settled",
      ],
    },
    actor: { type: "string", enum: ["owner", "runtime", "none"] },
    message: string,
  },
  required: ["kind", "actor", "message"],
  additionalProperties: false,
};
const notificationReceiptSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    runId: string,
    key: string,
    revision: integer,
    status: {
      type: "string",
      enum: ["pending", "delivering", "sent", "failed", "withdrawn"],
    },
    attempts: integer,
    attemptToken: string,
    updatedAt: integer,
  },
  required: ["runId", "key", "revision", "status", "attempts", "updatedAt"],
  additionalProperties: false,
};
const provenanceSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    request_ref: string,
    scope_summary: string,
    context_refs: { type: "array", items: string },
  },
  additionalProperties: false,
};
const paginationSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    mode: { type: "string", const: "snapshot" },
    capturedAt: integer,
    expiresAt: integer,
    total: integer,
    missingRunIds: { type: "array", items: string },
    nextCursor: string,
  },
  required: ["mode", "capturedAt", "expiresAt", "total", "missingRunIds"],
  additionalProperties: false,
};
const planComparisonSchema: JsonSchemaNode = {
  oneOf: [
    { type: "object", properties: {
      comparable: { type: "boolean", const: true },
      changes: { type: "object", properties: {
        addedSteps: { type: "array", items: string },
        removedSteps: { type: "array", items: string },
        changedSteps: { type: "array", items: { type: "object", properties: {
          id: string,
          fields: { type: "array", items: { type: "string", enum: ["tool", "input", "dependsOn", "retry", "timeoutMs"] } },
        }, required: ["id", "fields"], additionalProperties: false } },
        concurrencyChanged: { type: "boolean" },
        goalChanged: { type: "boolean" },
        provenanceChanged: { type: "boolean" },
        handoffChanged: { type: "boolean" },
      }, required: ["addedSteps", "removedSteps", "changedSteps", "concurrencyChanged", "goalChanged", "provenanceChanged", "handoffChanged"], additionalProperties: false },
    }, required: ["comparable", "changes"], additionalProperties: false },
    { type: "object", properties: {
      comparable: { type: "boolean", const: false },
      reason: { type: "string", enum: ["no_previous_run", "predecessor_unavailable", "incompatible_predecessor"] },
    }, required: ["comparable", "reason"], additionalProperties: false },
  ],
};

const summaryProperties: Record<string, JsonSchemaNode> = {
  runId: string,
  state: runState,
  goal: string,
  taskId: string,
  previousRunId: string,
  provenance: provenanceSchema,
  error: string,
  createdAt: integer,
  updatedAt: integer,
  finishedAt: integer,
  durationMs: integer,
  executionSettled: {
    type: "boolean",
    description:
      "Process-local scheduler/owned Worker cleanup settlement only; not proof ordinary host tools stopped.",
  },
  progress: progressSchema,
  guidance: guidanceSchema,
  recovery: recoverySchema,
  attention: attentionSchema,
  waiting: waitingSchema,
  ownerReview: ownerReviewSchema,
  decisionLedger: decisionLedgerSchema,
  action: actionSchema,
  steps: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: string,
        tool: string,
        state: stepState,
        attempts: integer,
        childSessionId: string,
        workerTrace: workerTraceSchema,
        error: string,
      },
      required: ["id", "tool", "state", "attempts"],
      additionalProperties: false,
    },
  },
};
// Keep additive projections optional for compatibility with older canonical values.
const summaryRequired = [
  "runId",
  "state",
  "createdAt",
  "updatedAt",
  "durationMs",
  "steps",
];
const summarySchema: JsonSchemaNode = {
  type: "object",
  properties: summaryProperties,
  required: summaryRequired,
  additionalProperties: false,
};
const receiptSchema: JsonSchemaNode = {
  type: "object",
  properties: { runId: string, state: { type: "string", const: "running" } },
  required: ["runId", "state"],
  additionalProperties: false,
};
const listSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    runs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          runId: string,
          state: runState,
          goal: string,
          taskId: string,
          previousRunId: string,
          provenance: provenanceSchema,
          error: string,
          updatedAt: integer,
          stepCount: integer,
          progress: progressSchema,
          guidance: guidanceSchema,
          attention: attentionSchema,
          waiting: waitingSchema,
          ownerReview: ownerReviewSchema,
  decisionLedger: decisionLedgerSchema,
          action: actionSchema,
        },
        required: ["runId", "state", "updatedAt", "stepCount"],
        additionalProperties: false,
      },
    },
    diagnostics: {
      type: "object",
      properties: {
        invalidRecords: integer,
        oversizedRecords: integer,
        readFailures: integer,
        writeFailures: integer,
        startedAt: {
          type: "integer",
          description:
            "Wall-clock milliseconds when this store instance was created; not process start time.",
        },
        observedAt: {
          type: "integer",
          description:
            "Wall-clock milliseconds when this diagnostics snapshot was read.",
        },
        lastObservedAt: {
          type: "object",
          description:
            "Most recent counted observation per category in this store instance, in wall-clock milliseconds; null means none observed. Counts are cumulative and saturated, not health judgments or persisted history.",
          properties: {
            invalidRecords: { oneOf: [{ type: "integer" }, { type: "null" }] },
            oversizedRecords: {
              oneOf: [{ type: "integer" }, { type: "null" }],
            },
            readFailures: { oneOf: [{ type: "integer" }, { type: "null" }] },
            writeFailures: { oneOf: [{ type: "integer" }, { type: "null" }] },
          },
          required: [
            "invalidRecords",
            "oversizedRecords",
            "readFailures",
            "writeFailures",
          ],
          additionalProperties: false,
        },
      },
      required: [
        "invalidRecords",
        "oversizedRecords",
        "readFailures",
        "writeFailures",
      ],
      additionalProperties: false,
    },
  },
  required: ["runs", "diagnostics"],
  additionalProperties: false,
};

/** Host-supported subset: dynamic step result keys/values deliberately remain JSON. */
const historyListSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    runs: { type: "array", items: summarySchema },
    offset: integer,
    limit: integer,
    hasMore: { type: "boolean" },
    scope: { type: "string", const: "retained_owner_runs" },
    order: { type: "string", const: "snapshot_membership" },
    pagination: paginationSchema,
    page: {
      type: "object",
      properties: {
        runCount: integer,
        activeCount: integer,
        attentionCount: integer,
        reviewCount: integer,
      },
      required: ["runCount", "activeCount", "attentionCount", "reviewCount"],
      additionalProperties: false,
    },
    diagnostics: (listSchema.properties as Record<string, JsonSchemaNode>)
      .diagnostics,
    message: string,
  },
  required: [
    "runs",
    "offset",
    "limit",
    "hasMore",
    "scope",
    "order",
    "pagination",
    "page",
    "diagnostics",
    "message",
  ],
  additionalProperties: false,
};
export const RUNTIME_OUTPUT_SCHEMAS: Record<string, JsonSchemaNode> = {
  runtime_capabilities: {
    type: "object",
    properties: {
      ordinaryDag: { type: "string", const: "supported" },
      worker: { type: "string", enum: ["conditional", "unavailable"] },
      workerReason: {
        type: "string",
        enum: [
          "trusted_adapter_missing",
          "parent_admission_missing",
          "execution_checks_required",
        ],
      },
      ordinaryAsync: { type: "boolean" },
      workerAsync: { type: "boolean", const: false },
      workerTools: {
        type: "array",
        items: { type: "string", enum: ["read", "glob", "grep"] },
      },
      limits: {
        type: "object",
        properties: {
          maxSteps: integer,
          maxConcurrency: integer,
          maxActiveRuns: integer,
          maxWorkers: integer,
        },
        required: ["maxSteps", "maxConcurrency", "maxActiveRuns", "maxWorkers"],
        additionalProperties: false,
      },
      capacity: {
        type: "object",
        properties: {
          scope: { type: "string", const: "module_process_root" },
          observedAt: integer,
          capacityBusy: { type: "boolean" },
        },
        required: ["scope", "observedAt", "capacityBusy"],
        additionalProperties: false,
      },
      authorization: { type: "string", const: "checked_at_execution" },
      message: string,
    },
    required: [
      "ordinaryDag",
      "worker",
      "workerReason",
      "ordinaryAsync",
      "workerAsync",
      "workerTools",
      "limits",
      "capacity",
      "authorization",
      "message",
    ],
    additionalProperties: false,
  },
  runtime_query: {
    type: "object",
    properties: {
      kind: { type: "string", const: "owner_metadata_query" },
      runs: { type: "array", items: {
        type: "object",
        properties: { runId: string, state: runState, goal: string, provenance: provenanceSchema,
          taskId: string, previousRunId: string, updatedAt: integer, stepCount: integer, action: actionSchema },
        required: ["runId", "state", "updatedAt", "stepCount", "action"], additionalProperties: false,
      } },
      view: { type: "string", enum: ["all", "needs_action", "review"] },
      offset: integer, limit: integer, matchedCount: integer,
      groups: { type: "object", properties: { needsAction: integer, review: integer },
        required: ["needsAction", "review"], additionalProperties: false },
      hasMore: { type: "boolean" },
      scope: { type: "string", const: "retained_owner_runs" },
      order: { type: "string", const: "updatedAt_desc_runId_asc" },
      observedAt: integer, scannedCount: integer, scanLimit: { type: "integer", const: 1000 },
      diagnostics: (listSchema.properties as Record<string, JsonSchemaNode>).diagnostics,
      message: string,
    },
    required: ["kind", "runs", "view", "offset", "limit", "matchedCount", "groups", "hasMore", "scope", "order", "observedAt", "scannedCount", "scanLimit", "diagnostics", "message"],
    additionalProperties: false,
  },
  runtime_handoff: handoffSchema,
  runtime_decision: {
    type: "object",
    properties: { ...summaryProperties, decisionHistory: decisionHistorySchema },
    required: [...summaryRequired, "decisionLedger", "decisionHistory"],
    additionalProperties: false,
  },
  runtime_acknowledge: {
    type: "object",
    properties: {
      ...summaryProperties,
      acknowledgementHistory: {
        type: "array",
        items: {
          type: "object",
          properties: {
            revision: integer,
            snapshotHash: string,
            key: string,
            reason: string,
            at: integer,
          },
          required: ["revision", "snapshotHash", "key", "reason", "at"],
          additionalProperties: false,
        },
      },
    },
    required: [...summaryRequired, "acknowledgementHistory"],
    additionalProperties: false,
  },
  runtime_review: {
    type: "object",
    properties: {
      ...summaryProperties,
      ownerReviewHistory: ownerReviewHistorySchema,
    },
    required: [...summaryRequired, "ownerReview", "ownerReviewHistory"],
    additionalProperties: false,
  },
  runtime_run: { oneOf: [receiptSchema, summarySchema] },
  runtime_task: {
    type: "object",
    properties: {
      taskId: string,
      pagination: paginationSchema,
      runs: { type: "array", items: summarySchema },
      offset: integer,
      limit: integer,
      hasMore: { type: "boolean" },
      scope: { type: "string", const: "retained_owner_runs" },
      order: {
        type: "string",
        enum: ["updatedAt_desc_runId_asc", "snapshot_membership"],
      },
      page: {
        type: "object",
        properties: {
          runCount: integer,
          activeCount: integer,
          attentionCount: integer,
          reviewCount: integer,
        },
        required: ["runCount", "activeCount", "attentionCount", "reviewCount"],
        additionalProperties: false,
      },
      diagnostics: (listSchema.properties as Record<string, JsonSchemaNode>)
        .diagnostics,
      message: string,
    },
    required: [
      "taskId",
      "runs",
      "offset",
      "limit",
      "hasMore",
      "scope",
      "order",
      "page",
      "diagnostics",
      "message",
    ],
    additionalProperties: false,
  },
  runtime_notification: {
    type: "object",
    properties: {
      runId: string,
      current: {
        type: "object",
        properties: { key: string, shouldNotify: { type: "boolean" } },
        required: ["key", "shouldNotify"],
        additionalProperties: false,
      },
      receipt: notificationReceiptSchema,
      verification: {
        type: "string",
        const: "owner_declared_not_delivery_verified",
      },
      message: string,
    },
    required: ["runId", "current", "verification", "message"],
    additionalProperties: false,
  },
  runtime_status: { oneOf: [summarySchema, listSchema, historyListSchema] },
  runtime_result: {
    type: "object",
    properties: {
      ...summaryProperties,
      planComparison: planComparisonSchema,
      handoff: handoffSchema,
      decisionHistory: decisionHistorySchema,
      acceptance: acceptanceSchema,
      ownerReviewHistory: ownerReviewHistorySchema,
      acknowledgementHistory: {
        type: "array",
        items: {
          type: "object",
          properties: {
            revision: integer,
            snapshotHash: string,
            key: string,
            reason: string,
            at: integer,
          },
          required: ["revision", "snapshotHash", "key", "reason", "at"],
          additionalProperties: false,
        },
      },
      page: {
        type: "object",
        properties: {
          stepId: string,
          encoding: { type: "string", const: "json" },
          unit: { type: "string", const: "unicode_code_point" },
          hash: string,
          offset: integer,
          total: integer,
          text: string,
          nextOffset: integer,
        },
        required: [
          "stepId",
          "encoding",
          "unit",
          "hash",
          "offset",
          "total",
          "text",
        ],
        additionalProperties: false,
      },
      results: {
        type: "object",
        description:
          "Step IDs map to StoredResult {value?: JSON, truncated?: true, bytes?: integer}; truncated values are not retained.",
      },
      finished: {
        type: "boolean",
        description:
          "Scheduling is terminal; not confirmation that a host process or Job stopped.",
      },
    },
    required: [...summaryRequired, "results", "finished"],
    additionalProperties: false,
  },
  runtime_cancel: summarySchema,
  runtime_resume: summarySchema,
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function progressText(value: unknown): string {
  const p = object(value);
  if (!p) return "";
  return (
    "步骤 " +
    p.total +
    "：成功 " +
    p.succeeded +
    "，运行 " +
    p.running +
    "，待执行 " +
    p.pending +
    "，失败 " +
    p.failed +
    "，取消 " +
    p.cancelled +
    "，unknown " +
    p.unknown
  );
}
const attentionPriority: Record<string, number> = {
  inspect_external_state: 0,
  inspect_failure: 1,
  resume_read_only: 2,
  decision_required: 3,
  result_unavailable: 4,
  review_results: 5,
};
const alertKinds = new Set([
  "inspect_external_state",
  "inspect_failure",
  "resume_read_only",
  "decision_required",
  "result_unavailable",
]);

function alertItems(value: unknown): Record<string, unknown>[] {
  return actionableItems(value).filter((item) =>
    alertKinds.has(item.kind as string),
  );
}

function actionableItems(value: unknown): Record<string, unknown>[] {
  const attention = object(object(value)?.attention);
  if (!Array.isArray(attention?.items)) return [];
  return attention.items
    .map(object)
    .filter((item): item is Record<string, unknown> =>
      Boolean(
        item &&
          typeof item.kind === "string" &&
          Object.hasOwn(attentionPriority, item.kind) &&
          !(item.kind === "decision_required" && ["answered", "superseded", "dismissed"].includes(String(item.disposition))),
      ),
    )
    .sort(
      (a, b) =>
        attentionPriority[a.kind as string]! -
        attentionPriority[b.kind as string]!,
    );
}

/** Read-only navigation: aggregate attention hashes are never pagination hashes. */
function resultLocation(
  runId: string,
  item: Record<string, unknown>,
): string[] {
  const request: Record<string, unknown> = { runId };
  if (item.kind === "decision_required" && typeof item.stepId === "string") {
    request.stepId = item.stepId;
    request.offset = 0;
    request.limit = 2048;
    if (
      typeof item.resultHash === "string" &&
      /^[a-f0-9]{64}$/.test(item.resultHash)
    )
      request.hash = item.resultHash;
  }
  const lines = ["只读定位：runtime_result(" + JSON.stringify(request) + ")"];
  if (request.stepId !== undefined)
    lines.push(
      "分页按 nextOffset 继续并沿用返回的 page.hash；拼接 page.text 后再解析 JSON。",
    );
  if (item.kind === "inspect_external_state")
    lines.push(
      "先核对对应步骤与后台回执；有 jobId 时由原 owner 收集 Job，无回执则先核实外部状态。不要自动重发。",
    );
  if (item.kind === "inspect_failure")
    lines.push("先检查失败步骤、错误码与已保存结果；此处不重试、不绕过失败。");
  if (item.kind === "resume_read_only")
    lines.push(
      "先核对原始提交计划及各步骤状态，再由 owner 显式请求 runtime_resume；仅只读在途步骤可重排，也可能继续尚未启动的步骤。此处不执行恢复、不增加授权。",
    );
  if (item.kind === "decision_required")
    lines.push(
      "读取完整 Worker 报告及证据后由 Lead 判断；请求决策不代表人工批准、执行授权或自动暂停，runtime_review 也不是回答 Worker 并续跑的接口。",
    );
  if (item.kind === "result_unavailable")
    lines.push(
      "先检查保存结果；缺失或 truncated 的原文不能通过分页恢复，需另行补取证据。",
    );
  if (item.kind === "review_results")
    lines.push(
      "先读取各步骤完整保存结果与证据；需要分页时使用 stepId 和该步骤返回的 hash，不使用待办聚合哈希。确认后可由 owner 显式调用 runtime_review 记录处置；处置不证明人工或独立验收。",
    );
  return lines;
}

function runText(value: unknown): string {
  const run = object(value);
  if (!run || typeof run.runId !== "string" || typeof run.state !== "string")
    return "";
  const lines = [run.runId + " · " + run.state];
  const action = object(run.action);
  if (typeof action?.message === "string")
    lines.push("当前行动：" + action.message);
  if (typeof run.taskId === "string") lines.push("任务：" + run.taskId);
  if (typeof run.previousRunId === "string")
    lines.push("前次运行：" + run.previousRunId + "（仅关联，可能已清理）");
  const comparison = object(run.planComparison);
  if (comparison?.comparable === false) {
    const reasons: Record<string, string> = {
      no_previous_run: "未关联前次运行",
      predecessor_unavailable: "前驱不可用（已清理、不可读或不可比较）",
      incompatible_predecessor: "前驱关联或状态不兼容",
    };
    lines.push("计划差异：不可比较 · " + (reasons[String(comparison.reason)] ?? "原因未知"));
  } else if (comparison?.comparable === true) {
    const changes = object(comparison.changes);
    if (changes) {
      const added = Array.isArray(changes.addedSteps) ? changes.addedSteps : [];
      const removed = Array.isArray(changes.removedSteps) ? changes.removedSteps : [];
      const changed = Array.isArray(changes.changedSteps) ? changes.changedSteps : [];
      const flags = [changes.concurrencyChanged ? "并发" : "", changes.goalChanged ? "目标" : "", changes.provenanceChanged ? "来源说明" : "", changes.handoffChanged ? "交接上下文" : ""].filter(Boolean);
      lines.push("计划差异：新增 " + added.length + "、删除 " + removed.length + "、修改 " + changed.length + " 个步骤" + (flags.length ? "；变化：" + flags.join("、") : ""));
      if (added.length) lines.push("新增步骤：" + added.join("、"));
      if (removed.length) lines.push("删除步骤：" + removed.join("、"));
      for (const entry of changed) {
        const step = object(entry);
        if (step && Array.isArray(step.fields)) lines.push("修改步骤：" + step.id + "（" + step.fields.join("、") + "）");
      }
      if (!added.length && !removed.length && !changed.length && !flags.length)
        lines.push("已比较：所列计划字段无变化（忽略对象键序、步骤顺序和依赖顺序）。");
      lines.push("仅计划描述差异，不展示输入正文或哈希；不证明行为等价或安全，不复用结果、不授权、不自动执行。");
    }
  }
  const provenance = object(run.provenance);
  const shown = (value: unknown) =>
    typeof value === "string"
      ? value.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 160) +
        (value.length > 160 ? "…（完整内容见JSON）" : "")
      : "未提供";
  lines.push("请求来源（说明，非授权凭据）：" + shown(provenance?.request_ref));
  lines.push(
    "约定范围（说明，不改变权限）：" + shown(provenance?.scope_summary),
  );
  lines.push(
    "仅供参考来源：" +
      (Array.isArray(provenance?.context_refs)
        ? provenance.context_refs.map(shown).join("；")
        : "未提供"),
  );
  const attention = object(run.attention);
  if (attention && Array.isArray(attention.items)) {
    const labels: Record<string, string> = {
      inspect_external_state: "先核验外部状态；不要自动重发",
      inspect_failure: "检查失败与已保存结果",
      resume_read_only: "中断运行待处置：核验计划后可显式恢复；此处不会执行",
      decision_required: "待 Lead 决策（Worker 请求，未经独立核实）",
      result_unavailable: "结果缺失或截断；补取证据",
      review_results: "结果待复核；执行成功不代表验收通过",
    };
    const items = actionableItems(run);
    const alerts = items.filter((item) => alertKinds.has(item.kind as string));
    const reviews = items.filter((item) => item.kind === "review_results");
    if (alerts.length) lines.push("待处理事项：");
    for (const item of alerts) {
      lines.push(
        (typeof item.stepId === "string" ? "[" + item.stepId + "] " : "") +
          labels[item.kind as string] +
          (item.acknowledged === true ? " · 已知悉（不等于解决或验收）" : ""),
        ...resultLocation(run.runId, item),
      );
    }
    if (reviews.length)
      lines.push(
        "详情：结果待复核（" +
          reviews.length +
          "）；执行成功不代表验收通过，不触发默认提醒。",
        ...reviews.flatMap((item) => resultLocation(String(run.runId), item)),
      );
    if (!alerts.length)
      lines.push("暂无必须处理提醒；常规进度和结果复核保留在摘要与 JSON 中。");
  }
  const decisions = object(run.decisionLedger);
  if (decisions && Array.isArray(decisions.items)) {
    const labels: Record<string, string> = { answered: "已记录答复", superseded: "被替代", dismissed: "不再处理" };
    for (const raw of decisions.items) {
      const item = object(raw);
      if (item && typeof item.status === "string" && Object.hasOwn(labels, item.status))
        lines.push("决策处置" + (typeof item.stepId === "string" ? "[" + item.stepId + "]" : "") + "：" + labels[item.status] + "（owner声明，不证明用户批准、解决或验收；详情见decisionHistory）。");
    }
  }
  lines.push(progressText(run.progress));
  if (typeof run.executionSettled === "boolean")
    lines.push(
      run.executionSettled
        ? "本进程调度/Worker 清理已收束；不证明普通工具退出。"
        : "本进程运行尚未收束；终态后可能仍在清理。",
    );
  const waiting = object(run.waiting);
  if (waiting && Array.isArray(waiting.steps)) {
    const labels: Record<string, string> = {
      dependency: "等待依赖成功",
      scheduler: "等待批次调度",
      retry_backoff: "只读重试退避",
    };
    const dispositions: Record<string, string> = {
      waiting_retry: "本次失败，按既有策略等待重试；未升级为待处理",
      needs_action: "重试条件不成立，需检查后再决定",
    };
    for (const raw of waiting.steps) {
      const item = object(raw);
      if (
        item &&
        typeof item.reason === "string" &&
        Object.hasOwn(labels, item.reason)
      )
        lines.push(
          "[" +
            item.stepId +
            "] " +
            labels[item.reason] +
            (typeof item.waitingSince === "number"
              ? " · 自 " + item.waitingSince
              : "") +
            (typeof item.nextRetryAt === "number"
              ? " · 下次尝试不早于 " + item.nextRetryAt
              : "") +
            (typeof item.disposition === "string" &&
            Object.hasOwn(dispositions, item.disposition)
              ? " · " + dispositions[item.disposition]
              : ""),
        );
    }
    if (waiting.cleanupPending === true)
      lines.push("等待本进程调度/Worker 清理；不确认外部 Job 已退出。");
  }
  const recovery = object(run.recovery);
  if (recovery)
    lines.push(
      "结果确定性：" +
        recovery.resultCertainty +
        " · 本进程清理：" +
        recovery.cleanup +
        " · 外部进程/Job：未确认",
      "下一步（" + recovery.nextAction + "）：" + recovery.message,
    );
  const review = object(run.ownerReview);
  if (review)
    lines.push(
      "Owner 处置：" +
        review.status +
        " · revision " +
        review.revision +
        "（owner声明，不证明人工或独立验收）",
    );
  const acceptance = object(run.acceptance);
  if (acceptance && Array.isArray(acceptance.workers)) {
    lines.push("验收：未独立复核（not_reviewed）；Worker 自报不代表任务通过。");
    for (const raw of acceptance.workers) {
      const worker = object(raw);
      if (!worker) continue;
      const counts = object(worker.criteria);
      lines.push(
        "[" +
          worker.stepId +
          "] " +
          worker.state +
          (typeof worker.reportOutcome === "string"
            ? " · 自报 " + worker.reportOutcome
            : "") +
          (counts
            ? " · observed " +
              counts.observed +
              " / 未验证 " +
              counts.notVerified +
              " / blocked " +
              counts.blocked
            : "") +
          (worker.decisionRequired === true ? " · 待 Lead 决策" : ""),
      );
    }
  }
  const page = object(run.page);
  if (page)
    lines.push(
      "结果分页：" +
        page.stepId +
        " · 偏移 " +
        page.offset +
        "/" +
        page.total +
        "（JSON 片段，完整拼接后再解析）",
    );
  if (typeof run.goal === "string") lines.push("目标：" + run.goal);
  if (typeof run.error === "string") lines.push("错误：" + run.error);
  // New summaries retain step-by-step progress in JSON, without repeating every step in the card.
  if (!attention && Array.isArray(run.steps))
    for (const raw of run.steps) {
      const step = object(raw);
      if (step)
        lines.push(
          step.id +
            " · " +
            step.tool +
            " · " +
            step.state +
            " · 尝试 " +
            step.attempts +
            (typeof step.error === "string" ? " · " + step.error : ""),
        );
    }
  if (Array.isArray(run.guidance))
    for (const raw of run.guidance) {
      const item = object(raw);
      if (
        typeof item?.message === "string" &&
        !(attention && item.code === "agent_requires_verification")
      ) {
        lines.push(
          (typeof item.stepId === "string" ? "[" + item.stepId + "] " : "") +
            item.message,
        );
        if (typeof item.jobId === "string") lines.push("jobId: " + item.jobId);
      }
    }
  if (!run.progress && !run.steps && run.stepCount === undefined)
    lines.push(
      "已受理异步运行。请用 runtime_status/runtime_result 显式取回；不要轮询正在等待的 runtime_run。",
    );
  if (Object.hasOwn(run, "results"))
    lines.push(
      "步骤原始结果保留在工具 JSON 返回值中；truncated 仅是截断标记，不是完整结果。",
    );
  return lines.filter(Boolean).join("\n");
}

const alertLabels: Record<string, string> = {
  inspect_external_state: "外部状态未知",
  inspect_failure: "失败待查",
  resume_read_only: "中断待处置",
  decision_required: "待决策",
  result_unavailable: "结果缺失",
};

/** Current page only. Reviews stay out of the alert count and nothing is executed. */
function pageAlertSummary(runs: unknown[]): string {
  const counts = new Map<string, number>();
  let reviews = 0;
  for (const run of runs) {
    for (const item of actionableItems(run)) {
      const kind = item.kind as string;
      if (alertKinds.has(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
      else if (kind === "review_results") reviews++;
    }
  }
  const alerts = Object.keys(alertLabels)
    .filter((kind) => counts.has(kind))
    .map((kind) => alertLabels[kind] + " " + counts.get(kind));
  return (
    "本页待办：" +
    (alerts.length ? alerts.join("，") : "无必须处理事项") +
    "；结果待复核 " +
    reviews +
    "（不触发提醒，不代表全部会话）。"
  );
}

/** Keep every run's identity and locators, even when attention kinds match. */
function renderRunList(runs: unknown[]): string {
  const urgent: string[] = [];
  const quiet: string[] = [];
  for (const run of runs) {
    const text = runText(run);
    (alertItems(run).length ? urgent : quiet).push(text);
  }
  return [
    pageAlertSummary(runs),
    "本页运行（必须处理优先；逐项保留运行与读取入口；不代表全部待办）：",
    ...urgent,
    ...quiet,
  ].join("\n\n");
}

/** Replayable metadata excludes inputs, raw result values and owner identity. */
export function runtimePresentationMeta(_args: unknown, value: unknown) {
  const result = object(value);
  if (result?.ordinaryDag === "supported" && typeof result.worker === "string")
    return {
      title: "萧何能力说明",
      text:
        "普通 DAG：支持（执行时准入）\nWorker：" +
        result.worker +
        " · " +
        result.workerReason +
        "\n普通异步：" +
        result.ordinaryAsync +
        " · Worker 异步：false\n" +
        (typeof object(result.capacity)?.capacityBusy === "boolean"
          ? object(result.capacity)?.capacityBusy
            ? "共享运行准入：繁忙（瞬时观察，不排队）\n"
            : "共享运行准入：未观察到满载（不保证可用）\n"
          : "") +
        result.message,
    };
  if (result?.kind === "untrusted_run_handoff") return {
    title: "萧何运行摘要",
    text: "显式上下文交接 · 来源 " + result.sourceRunId + " · 任务 " + result.taskId +
      "\n摘要及所选步骤见工具JSON；内容未经核实，不授权、不执行，不自动注入Worker，不复用执行结果。",
  };
  if (result?.verification === "owner_declared_not_delivery_verified") {
    const receipt = object(result.receipt);
    return {
      title: "萧何运行摘要",
      text:
        "通知投递：" +
        (receipt?.status ?? "未入队") +
        " · revision " +
        (receipt?.revision ?? 0) +
        "\n" +
        result.message,
    };
  }
  if (result?.kind === "owner_metadata_query" && Array.isArray(result.runs)) {
    const groups = object(result.groups);
    return {
      title: "萧何运行摘要",
      text: "跨任务元数据查询 · " + result.view + " · 匹配运行 " + result.matchedCount +
        " · 本页 " + result.runs.length + " · offset " + result.offset + " · 后续页 " + result.hasMore +
        "\n分组（其他条件后、view前）：必须处理 " + groups?.needsAction + " · 待复核 " + groups?.review +
        "\n" + result.message + "\n\n" +
        (result.runs.length ? result.runs.map(runText).join("\n\n") : "当前条件及范围内无可读取运行，不证明没有待办。"),
    };
  }
  const text = Array.isArray(result?.runs)
    ? result.runs.length
      ? renderRunList(result.runs)
      : result?.scope === "retained_owner_runs"
        ? "本页无可读取运行；请检查缺失项及后续页。"
        : "本会话暂无运行。"
    : runText(value);
  return {
    title: "萧何运行摘要",
    text:
      result?.scope === "retained_owner_runs"
        ? "任务：" +
          (result.taskId ?? "全部保留运行") +
          " · offset " +
          result.offset +
          " · 后续页 " +
          result.hasMore +
          "\n" +
          result.message +
          (object(result.pagination)
            ? "\n固定快照 · 缺失项 " +
              JSON.stringify(object(result.pagination)?.missingRunIds) +
              " · 下一页cursor " +
              (object(result.pagination)?.nextCursor ?? "无")
            : "") +
          "\n\n" +
          text
        : text,
  };
}

export function presentRuntimeResult(
  _args: unknown,
  result: ToolResult,
): ToolResultView | undefined {
  if (result.isError) return undefined;
  const meta = object(result.meta);
  if (typeof meta?.text !== "string" || !meta.text) return undefined;
  return {
    card: "generic",
    title: meta.title === "萧何能力说明" ? "萧何能力说明" : "萧何运行摘要",
    content: [{ type: "text", text: meta.text }],
  };
}
