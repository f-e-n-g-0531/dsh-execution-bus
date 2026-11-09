import { runAttention } from "./attention.js";
import { runRecovery } from "./insights.js";
import type { RunRecord } from "./store.js";
import { runWaiting } from "./waiting.js";

export type RunActionKind =
  | "inspect_external_state"
  | "wait_cleanup"
  | "inspect_failure"
  | "decision_required"
  | "result_unavailable"
  | "resume_read_only"
  | "review_results"
  | "wait_retry"
  | "working"
  | "settled";

export interface RunAction {
  kind: RunActionKind;
  actor: "owner" | "runtime" | "none";
  message: string;
}

const OWNER_ACTIONS = [
  "inspect_failure",
  "decision_required",
  "result_unavailable",
  "resume_read_only",
  "review_results",
] as const;

const OWNER_MESSAGES: Record<(typeof OWNER_ACTIONS)[number], string> = {
  inspect_failure: "由 owner 检查失败与已保存结果；此提示不执行重试或恢复。",
  decision_required:
    "由 owner 核验 Worker 请求及证据后决策；Worker 自报不构成授权或独立验收。",
  result_unavailable:
    "由 owner 检查缺失或截断的已保存结果；结果不可用不代表操作未执行，不要自动重发。",
  resume_read_only:
    "由 owner 核验计划与授权后显式请求只读恢复；此处不执行恢复，也不重放 agent 或副作用步骤。",
  review_results:
    "由 owner 读取完整结果与证据并记录复核处置；执行成功和 owner 声明均不证明独立验收或人工批准。",
};

/**
 * Display-only next action, derived from current observations. No storage,
 * execution, acknowledgement, retry grant, or private payload is returned.
 */
export function runAction(run: RunRecord, settled?: boolean): RunAction {
  const recovery = runRecovery(run, settled);
  // Uncertainty cannot be dismissed by acknowledgement or owner review.
  if (recovery.nextAction === "inspect_external_state")
    return {
      kind: "inspect_external_state",
      actor: "owner",
      message:
        "由 owner 先核验外部状态与已保存结果；已知悉不等于解决，未知不代表失败或回滚，不要自动重发。",
    };

  const waiting = runWaiting(run, settled);
  if (waiting.cleanupPending)
    return {
      kind: "wait_cleanup",
      actor: "runtime",
      message:
        "等待本进程调度及 owned Worker 清理收束；不确认普通宿主调用或后台 Job 已停止，不自动恢复或重跑。",
    };

  const attention = runAttention(run, settled);
  for (const kind of OWNER_ACTIONS) {
    if (
      attention.items.some((item) => item.kind === kind && !item.acknowledged &&
        !(item.kind === "decision_required" && item.disposition))
    )
      return { kind, actor: "owner", message: OWNER_MESSAGES[kind] };
  }

  if (run.state === "running") {
    if (waiting.steps.some((step) => step.reason === "retry_backoff"))
      return {
        kind: "wait_retry",
        actor: "runtime",
        message:
          "运行中有步骤处于重试退避；等待运行时按既有策略处理，此提示不授予重试权限，也不保证重试成功。",
      };
    return {
      kind: "working",
      actor: "runtime",
      message: "运行时仍在调度或执行；等待当前工作，此提示不证明外部操作完成。",
    };
  }

  return {
    kind: "settled",
    actor: "none",
    message:
      "调度已达终态，当前无未知悉待办；已知悉不等于问题已解决，owner 复核声明不证明独立验收或人工批准，也不表示交付完成。" +
      (recovery.cleanup === "unknown"
        ? " 本进程清理状态未知，普通宿主调用及后台 Job 状态仍须另行核验。"
        : " 本进程调度/owned Worker 已收束，不确认普通宿主调用或后台 Job 已停止。"),
  };
}
