import { ERRORS } from "./error-codes.js";
import { IDEMPOTENT_TOOLS } from "./runtime/plan.js";
/** Derived only after the service selected an owned record; never persisted. */
export function runProgress(run) {
    const progress = {
        total: run.steps.length,
        pending: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        unknown: 0,
    };
    for (const step of run.steps)
        progress[step.state]++;
    return progress;
}
/** Advice is not an execution policy, authorization, or proof a Job stopped. */
export function runGuidance(run) {
    const guidance = [];
    let unsafeResume = run.steps.some((step) => step.state === "failed");
    for (const step of run.steps) {
        if (step.tool === "agent" && step.state === "succeeded") {
            guidance.push({
                code: "agent_requires_verification",
                stepId: step.id,
                message: "Worker 已返回，不代表任务独立验收通过。Lead 必须检查结果与证据；依赖成功仅表示执行完成。",
            });
        }
        const uncertain = step.state === "unknown" ||
            (run.state === "interrupted" && step.state === "running");
        const unsafe = !IDEMPOTENT_TOOLS.has(step.tool) &&
            (uncertain || step.error === ERRORS.RUNTIME_INTERRUPTED);
        if (unsafe) {
            unsafeResume = true;
            guidance.push({
                code: "unknown_side_effect",
                stepId: step.id,
                message: "副作用结果未知，不代表失败、回滚或进程已停止。请先核验外部状态；不要自动重发或用新计划盲目重跑。runtime_resume 不会重放该步骤，并会停止整个恢复计划。",
            });
        }
        else if (uncertain) {
            guidance.push({
                code: "unknown_read",
                stepId: step.id,
                message: "只读步骤结果未确认；interrupted 运行可显式恢复。旧调用可能仍在执行，不要据此假定它已经停止。",
            });
        }
        // Only executor-owned pwsh background receipts are locators. Never scan
        // arbitrary read/grep output for Job IDs, or expose plan inputs/raw values.
        const receipt = run.results[step.id];
        const value = receipt?.value;
        if (step.tool === "pwsh" &&
            step.error === ERRORS.RUNTIME_BACKGROUND_UNSUPPORTED) {
            const job = !receipt?.truncated ? object(value) : undefined;
            if ((job?.kind === "background" || job?.kind === "promoted") &&
                typeof job.jobId === "string" &&
                job.jobId.trim()) {
                guidance.push({
                    code: "background_job",
                    stepId: step.id,
                    jobId: job.jobId,
                    message: "宿主命令已转后台，Job 可能仍在运行，依赖步骤未获成功许可。请由原 owner 用 job_output 收集；若决定停止，再显式 job_kill。这里不会自动调用 Job 工具；取消运行也不确认 Job 已停止。",
                    suggestions: [
                        { tool: "job_output", input: { job_id: job.jobId } },
                        { tool: "job_kill", input: { job_id: job.jobId } },
                    ],
                });
            }
            else {
                guidance.push({
                    code: "background_job_unlocated",
                    stepId: step.id,
                    message: "后台回执没有可用 jobId。请由原 owner 用 job_list 核实，不要猜测 ID 或重发命令。",
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
    if (run.state === "failed" &&
        run.steps.some((step) => step.state === "pending"))
        guidance.push({
            code: "pending_not_scheduled",
            message: "运行已失败；pending 步骤未获调度或成功确认，不会继续自动执行。不要将待执行计数解读为仍在后台推进。",
        });
    if (run.state === "cancelled")
        guidance.push({
            code: "cancelled",
            message: "已停止运行调度并请求取消；这不确认不合作的宿主工具或后台 Job 已停止。",
        });
    if (run.error === ERRORS.RUNTIME_STORAGE_FAILED)
        guidance.push({
            code: "storage_failure",
            message: "运行记录保存失败；当前状态可能只在本进程可见，磁盘记录可能落后。请核验实际副作用，不要依赖旧检查点自动重跑。",
        });
    return guidance;
}
const string = { type: "string" };
const integer = { type: "integer" };
const runState = {
    type: "string",
    enum: ["running", "succeeded", "failed", "cancelled", "interrupted"],
};
const stepState = {
    type: "string",
    enum: ["pending", "running", "succeeded", "failed", "cancelled", "unknown"],
};
const progressSchema = {
    type: "object",
    properties: Object.fromEntries([
        "total",
        "pending",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "unknown",
    ].map((key) => [key, integer])),
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
const guidanceSchema = {
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
const workerModelSchema = {
    type: "object",
    properties: { provider: string, model: string, reasoningEffort: string },
    required: ["provider", "model"],
    additionalProperties: false,
};
const workerTraceSchema = {
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
const attentionSchema = {
    type: "object",
    properties: {
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
const waitingSchema = {
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
const recoverySchema = {
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
const acceptanceSchema = {
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
const ownerReviewSchema = {
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
const ownerReviewHistorySchema = {
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
const summaryProperties = {
    runId: string,
    state: runState,
    goal: string,
    taskId: string,
    previousRunId: string,
    error: string,
    createdAt: integer,
    updatedAt: integer,
    finishedAt: integer,
    durationMs: integer,
    executionSettled: {
        type: "boolean",
        description: "Process-local scheduler/owned Worker cleanup settlement only; not proof ordinary host tools stopped.",
    },
    progress: progressSchema,
    guidance: guidanceSchema,
    recovery: recoverySchema,
    attention: attentionSchema,
    waiting: waitingSchema,
    ownerReview: ownerReviewSchema,
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
const summarySchema = {
    type: "object",
    properties: summaryProperties,
    required: summaryRequired,
    additionalProperties: false,
};
const receiptSchema = {
    type: "object",
    properties: { runId: string, state: { type: "string", const: "running" } },
    required: ["runId", "state"],
    additionalProperties: false,
};
const listSchema = {
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
                    error: string,
                    updatedAt: integer,
                    stepCount: integer,
                    progress: progressSchema,
                    guidance: guidanceSchema,
                    attention: attentionSchema,
                    waiting: waitingSchema,
                    ownerReview: ownerReviewSchema,
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
export const RUNTIME_OUTPUT_SCHEMAS = {
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
            "authorization",
            "message",
        ],
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
    runtime_status: { oneOf: [summarySchema, listSchema] },
    runtime_result: {
        type: "object",
        properties: {
            ...summaryProperties,
            acceptance: acceptanceSchema,
            ownerReviewHistory: ownerReviewHistorySchema,
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
                description: "Step IDs map to StoredResult {value?: JSON, truncated?: true, bytes?: integer}; truncated values are not retained.",
            },
            finished: {
                type: "boolean",
                description: "Scheduling is terminal; not confirmation that a host process or Job stopped.",
            },
        },
        required: [...summaryRequired, "results", "finished"],
        additionalProperties: false,
    },
    runtime_cancel: summarySchema,
    runtime_resume: summarySchema,
};
function object(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function progressText(value) {
    const p = object(value);
    if (!p)
        return "";
    return ("步骤 " +
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
        p.unknown);
}
const attentionPriority = {
    inspect_external_state: 0,
    inspect_failure: 1,
    resume_read_only: 2,
    decision_required: 3,
    result_unavailable: 4,
    review_results: 5,
};
function actionableItems(value) {
    const attention = object(object(value)?.attention);
    if (!Array.isArray(attention?.items))
        return [];
    return attention.items
        .map(object)
        .filter((item) => Boolean(item &&
        typeof item.kind === "string" &&
        Object.hasOwn(attentionPriority, item.kind)))
        .sort((a, b) => attentionPriority[a.kind] -
        attentionPriority[b.kind]);
}
/** Read-only navigation: aggregate attention hashes are never pagination hashes. */
function resultLocation(runId, item) {
    if (!["decision_required", "review_results", "result_unavailable"].includes(item.kind))
        return [];
    const request = { runId };
    if (item.kind === "decision_required" && typeof item.stepId === "string") {
        request.stepId = item.stepId;
        request.offset = 0;
        request.limit = 2048;
        if (typeof item.resultHash === "string" &&
            /^[a-f0-9]{64}$/.test(item.resultHash))
            request.hash = item.resultHash;
    }
    const lines = ["只读定位：runtime_result(" + JSON.stringify(request) + ")"];
    if (request.stepId !== undefined)
        lines.push("分页按 nextOffset 继续并沿用返回的 page.hash；拼接 page.text 后再解析 JSON。");
    if (item.kind === "result_unavailable")
        lines.push("先检查保存结果；缺失或 truncated 的原文不能通过分页恢复，需另行补取证据。");
    if (item.kind === "review_results")
        lines.push("先读取各步骤保存结果；需要分页时使用 stepId 和该步骤返回的 hash，不使用待办聚合哈希。");
    return lines;
}
function runText(value) {
    const run = object(value);
    if (!run || typeof run.runId !== "string" || typeof run.state !== "string")
        return "";
    const lines = [run.runId + " · " + run.state];
    const attention = object(run.attention);
    if (attention && Array.isArray(attention.items)) {
        const labels = {
            inspect_external_state: "先核验外部状态；不要自动重发",
            inspect_failure: "检查失败与已保存结果",
            resume_read_only: "中断运行待处置：核验计划后可显式恢复；此处不会执行",
            decision_required: "待 Lead 决策（Worker 请求，未经独立核实）",
            result_unavailable: "结果缺失或截断；补取证据",
            review_results: "结果待复核；执行成功不代表验收通过",
        };
        const items = actionableItems(run);
        if (items.length)
            lines.push("待处理事项：");
        for (const item of items) {
            lines.push((typeof item.stepId === "string" ? "[" + item.stepId + "] " : "") +
                labels[item.kind], ...resultLocation(run.runId, item));
        }
        if (!attention.items.length)
            lines.push("暂无待处理提醒；常规进度仅保留在摘要与 JSON 中。");
    }
    lines.push(progressText(run.progress));
    if (typeof run.executionSettled === "boolean")
        lines.push(run.executionSettled
            ? "本进程调度/Worker 清理已收束；不证明普通工具退出。"
            : "本进程运行尚未收束；终态后可能仍在清理。");
    const waiting = object(run.waiting);
    if (waiting && Array.isArray(waiting.steps)) {
        const labels = {
            dependency: "等待依赖成功",
            scheduler: "等待批次调度",
            retry_backoff: "只读重试退避",
        };
        for (const raw of waiting.steps) {
            const item = object(raw);
            if (item &&
                typeof item.reason === "string" &&
                Object.hasOwn(labels, item.reason))
                lines.push("[" +
                    item.stepId +
                    "] " +
                    labels[item.reason] +
                    (typeof item.waitingSince === "number"
                        ? " · 自 " + item.waitingSince
                        : "") +
                    (typeof item.nextRetryAt === "number"
                        ? " · 下次尝试不早于 " + item.nextRetryAt
                        : ""));
        }
        if (waiting.cleanupPending === true)
            lines.push("等待本进程调度/Worker 清理；不确认外部 Job 已退出。");
    }
    const recovery = object(run.recovery);
    if (recovery)
        lines.push("结果确定性：" +
            recovery.resultCertainty +
            " · 本进程清理：" +
            recovery.cleanup +
            " · 外部进程/Job：未确认", "下一步（" + recovery.nextAction + "）：" + recovery.message);
    const review = object(run.ownerReview);
    if (review)
        lines.push("Owner 处置：" +
            review.status +
            " · revision " +
            review.revision +
            "（owner声明，不证明人工或独立验收）");
    const acceptance = object(run.acceptance);
    if (acceptance && Array.isArray(acceptance.workers)) {
        lines.push("验收：未独立复核（not_reviewed）；Worker 自报不代表任务通过。");
        for (const raw of acceptance.workers) {
            const worker = object(raw);
            if (!worker)
                continue;
            const counts = object(worker.criteria);
            lines.push("[" +
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
                (worker.decisionRequired === true ? " · 待 Lead 决策" : ""));
        }
    }
    const page = object(run.page);
    if (page)
        lines.push("结果分页：" +
            page.stepId +
            " · 偏移 " +
            page.offset +
            "/" +
            page.total +
            "（JSON 片段，完整拼接后再解析）");
    if (typeof run.goal === "string")
        lines.push("目标：" + run.goal);
    if (typeof run.error === "string")
        lines.push("错误：" + run.error);
    // New summaries retain step-by-step progress in JSON, without repeating every step in the card.
    if (!attention && Array.isArray(run.steps))
        for (const raw of run.steps) {
            const step = object(raw);
            if (step)
                lines.push(step.id +
                    " · " +
                    step.tool +
                    " · " +
                    step.state +
                    " · 尝试 " +
                    step.attempts +
                    (typeof step.error === "string" ? " · " + step.error : ""));
        }
    if (Array.isArray(run.guidance))
        for (const raw of run.guidance) {
            const item = object(raw);
            if (typeof item?.message === "string" &&
                !(attention && item.code === "agent_requires_verification")) {
                lines.push((typeof item.stepId === "string" ? "[" + item.stepId + "] " : "") +
                    item.message);
                if (typeof item.jobId === "string")
                    lines.push("jobId: " + item.jobId);
            }
        }
    if (!run.progress && !run.steps && run.stepCount === undefined)
        lines.push("已受理异步运行。请用 runtime_status/runtime_result 显式取回；不要轮询正在等待的 runtime_run。");
    if (Object.hasOwn(run, "results"))
        lines.push("步骤原始结果保留在工具 JSON 返回值中；truncated 仅是截断标记，不是完整结果。");
    return lines.filter(Boolean).join("\n");
}
/** Replayable metadata excludes inputs, raw result values and owner identity. */
export function runtimePresentationMeta(_args, value) {
    const result = object(value);
    if (result?.ordinaryDag === "supported" && typeof result.worker === "string")
        return {
            title: "萧何能力说明",
            text: "普通 DAG：支持（执行时准入）\nWorker：" +
                result.worker +
                " · " +
                result.workerReason +
                "\n普通异步：" +
                result.ordinaryAsync +
                " · Worker 异步：false\n" +
                result.message,
        };
    const text = Array.isArray(result?.runs)
        ? result.runs.length
            ? [
                "本页运行（待处理优先；不代表全部待办）：",
                ...result.runs
                    .filter((run) => actionableItems(run).length > 0)
                    .map(runText),
                ...result.runs
                    .filter((run) => actionableItems(run).length === 0)
                    .map(runText),
            ].join("\n\n")
            : "本会话暂无运行。"
        : runText(value);
    return { title: "萧何运行摘要", text };
}
export function presentRuntimeResult(_args, result) {
    if (result.isError)
        return undefined;
    const meta = object(result.meta);
    if (typeof meta?.text !== "string" || !meta.text)
        return undefined;
    return {
        card: "generic",
        title: meta.title === "萧何能力说明" ? "萧何能力说明" : "萧何运行摘要",
        content: [{ type: "text", text: meta.text }],
    };
}
