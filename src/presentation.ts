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
const summaryProperties: Record<string, JsonSchemaNode> = {
  runId: string,
  state: runState,
  goal: string,
  error: string,
  createdAt: integer,
  updatedAt: integer,
  finishedAt: integer,
  durationMs: integer,
  progress: progressSchema,
  guidance: guidanceSchema,
  steps: {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: string,
        tool: string,
        state: stepState,
        attempts: integer,
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
          error: string,
          updatedAt: integer,
          stepCount: integer,
          progress: progressSchema,
          guidance: guidanceSchema,
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
export const RUNTIME_OUTPUT_SCHEMAS: Record<string, JsonSchemaNode> = {
  runtime_run: { oneOf: [receiptSchema, summarySchema] },
  runtime_status: { oneOf: [summarySchema, listSchema] },
  runtime_result: {
    type: "object",
    properties: {
      ...summaryProperties,
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
function runText(value: unknown): string {
  const run = object(value);
  if (!run || typeof run.runId !== "string" || typeof run.state !== "string")
    return "";
  const lines = [run.runId + " · " + run.state, progressText(run.progress)];
  if (typeof run.goal === "string") lines.push("目标：" + run.goal);
  if (typeof run.error === "string") lines.push("错误：" + run.error);
  if (Array.isArray(run.steps))
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
      if (typeof item?.message === "string") {
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

/** Replayable metadata excludes inputs, raw result values and owner identity. */
export function runtimePresentationMeta(_args: unknown, value: unknown) {
  const result = object(value);
  const text = Array.isArray(result?.runs)
    ? result.runs.length
      ? result.runs.map(runText).join("\n\n")
      : "本会话暂无运行。"
    : runText(value);
  return { title: "萧何运行摘要", text };
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
    title: "萧何运行摘要",
    content: [{ type: "text", text: meta.text }],
  };
}
