import { createHash } from "node:crypto";
import { ERRORS } from "../error-codes.js";
import { parseAcceptanceCriteria, parseWorkerReport } from "./agent-report.js";
import { IDEMPOTENT_TOOLS } from "./plan.js";
/** Worker claims only; never independent verification or an acceptance decision. */
export function runAcceptance(run) {
    const workers = run.steps
        .filter((step) => step.tool === "agent")
        .map((step) => {
        const worker = { stepId: step.id, state: step.state };
        const stored = Object.hasOwn(run.results, step.id)
            ? run.results[step.id]
            : undefined;
        if (step.state !== "succeeded" ||
            !stored ||
            stored.truncated ||
            !Object.hasOwn(stored, "value"))
            return worker;
        try {
            const text = JSON.stringify(stored.value);
            if (text === undefined)
                return worker;
            // Match service result pagination: SHA256 of the complete value JSON.
            worker.resultHash = createHash("sha256").update(text).digest("hex");
            const value = stored.value;
            if (!value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                !Object.hasOwn(value, "report"))
                return worker;
            const input = run.plan.steps.find((spec) => spec.id === step.id && spec.tool === "agent")?.input;
            const criteria = input?.acceptance_criteria === undefined
                ? undefined
                : parseAcceptanceCriteria(input.acceptance_criteria);
            // executeAgent stores the parsed report object, not the wire output string.
            const reportText = JSON.stringify(value.report);
            if (reportText === undefined)
                return worker;
            const report = parseWorkerReport(reportText, criteria);
            worker.reportOutcome = report.outcome;
            worker.evidenceCount = report.evidence.length;
            worker.limitationCount = report.limitations.length;
            worker.decisionRequired = Boolean(report.requestedDecision?.trim());
            if (report.criteria) {
                worker.criteria = { observed: 0, notVerified: 0, blocked: 0 };
                for (const item of report.criteria) {
                    if (item.status === "not_verified")
                        worker.criteria.notVerified++;
                    else
                        worker.criteria[item.status]++;
                }
            }
        }
        catch {
            // A malformed/unavailable report never becomes coverage or acceptance.
        }
        return worker;
    });
    return { status: "not_reviewed", workers };
}
/** Advice only: no storage, execution, retry, cancellation or authorization. */
export function runRecovery(run, settled) {
    const uncertain = run.steps.some((step) => step.state === "unknown" ||
        (run.state === "interrupted" && step.state === "running"));
    const unsafe = run.steps.some((step) => !IDEMPOTENT_TOOLS.has(step.tool) &&
        (step.state === "unknown" ||
            (run.state === "interrupted" && step.state === "running") ||
            step.error === ERRORS.RUNTIME_INTERRUPTED));
    const storageFailed = run.error === ERRORS.RUNTIME_STORAGE_FAILED ||
        run.steps.some((step) => step.error === ERRORS.RUNTIME_STORAGE_FAILED);
    const incomplete = run.state !== "succeeded" ||
        run.steps.some((step) => {
            const stored = Object.hasOwn(run.results, step.id)
                ? run.results[step.id]
                : undefined;
            return (step.state !== "succeeded" ||
                !stored ||
                stored.truncated ||
                !Object.hasOwn(stored, "value"));
        });
    const resultCertainty = storageFailed || uncertain || unsafe
        ? "unknown"
        : incomplete
            ? "incomplete"
            : "recorded";
    let nextAction;
    let message;
    if (storageFailed || unsafe) {
        nextAction = "inspect_external_state";
        message =
            "存储失败或副作用结果未知；先核验外部状态与已保存结果，不要自动重发。未知不代表失败或回滚。";
    }
    else if (run.state === "running" || settled === false) {
        nextAction = "wait";
        message =
            "本进程调度或清理尚未收束；等待当前工作，不要据此重跑或启动恢复。";
    }
    else if (run.state === "interrupted" &&
        !run.steps.some((step) => step.state === "failed")) {
        nextAction = "resume_read_only";
        message =
            "可显式请求恢复：保留成功步骤，仅 read/glob/grep 在途步骤可重排；agent 和副作用步骤不会重放。恢复可能继续尚未启动的步骤，须先核验计划；此处不执行任何操作。";
    }
    else if (uncertain || run.state === "cancelled") {
        nextAction = "inspect_external_state";
        message =
            "先核验外部状态与已保存结果；取消或未知状态不确认宿主调用已停止，不要自动重跑。";
    }
    else if (run.state === "failed" ||
        run.steps.some((step) => step.state === "failed")) {
        nextAction = "inspect_failure";
        message =
            "检查失败与已保存结果；失败步骤阻止恢复继续，不会自动重试或绕过失败。";
    }
    else {
        nextAction = "review_results";
        message =
            "检查已保存结果及证据；执行成功或 Worker 自报覆盖均不代表独立验收通过，缺失或截断结果不完整。";
    }
    return {
        resultCertainty,
        cleanup: settled === true ? "settled" : settled === false ? "pending" : "unknown",
        externalWork: "unconfirmed",
        nextAction,
        message: message +
            " cleanup 仅指本进程调度/owned Worker 清理，不确认普通宿主工具或后台 Job 已停止。",
    };
}
