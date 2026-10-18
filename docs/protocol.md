# 协议与运行语义（1.0）

## 工具

| 工具 | 输入 | 返回 |
|---|---|---|
| `runtime_run` | `{ plan, async? }` | 同步：运行摘要与步骤状态；`async:true`：`{ runId, state:"running" }` |
| `runtime_status` | `{}` 或 `{ runId }` | 最近运行列表或指定运行元数据（不含结果） |
| `runtime_result` | `{ runId }` | 运行摘要 + 已保存步骤结果（`truncated/bytes` 标记） |
| `runtime_cancel` | `{ runId }` | 取消后的运行摘要 |
| `runtime_resume` | `{ runId }` | 恢复后的运行摘要；仅 `interrupted` 可恢复 |

## 计划（plan）

`plan = { goal?, concurrency?, steps[] }`；`step = { id, tool, input, depends_on?, retry?, timeout_ms? }`。

- 允许工具：`read/glob/grep/edit/write/pwsh`；`retry` 只允许 `read/glob/grep`（0–3）。
- 约束：1–32 步；计划 ≤64KiB；并发 1–4；单步超时 1s–600s；`id` 唯一、依赖必须存在、禁止环。
- 步骤输入原样交给宿主工具管线，按工具自身 schema 与权限执行。

## 状态

- 运行：`running | succeeded | failed | cancelled | interrupted`。
- 步骤：`pending | running | succeeded | failed | cancelled | unknown`。
- `interrupted` 表示进程重启/退出时运行未完成；启动时把 `running` 步骤改为 `unknown`。

## 持久化与恢复

- 记录路径：`DSH_HOME/tmp/xiaohe-runtime/runs/<runId>.json`（`XIAOHE_RUNTIME_DIR` 可覆盖）；原子写，损坏记录忽略，默认保留最近 100 条。
- 恢复只针对 `interrupted`：只读步骤重新排队；副作用在途步骤标 `failed/RUNTIME_INTERRUPTED`。**不保证 exactly-once**。
- 运行记录按会话隔离：status/result/cancel/resume 只允许所有者会话。
- 单步结果 >64KiB 只保存截断标记，避免无界内存/磁盘。

## 错误码（运行时）

`INVALID_PLAN`、`PLAN_TOO_LARGE`、`PLAN_DUPLICATE_ID`、`PLAN_UNKNOWN_DEP`、`PLAN_CYCLE`、`PLAN_UNKNOWN_TOOL`、`PLAN_RETRY_DENIED`、`RUNTIME_NOT_FOUND`、`RUNTIME_INVALID_STATE`、`RUNTIME_STEP_TIMEOUT`、`RUNTIME_CANCELLED`、`RUNTIME_INTERRUPTED`、`RUNTIME_STEP_FAILED`、`RUNTIME_BUSY`、`OWNING_SESSION_REQUIRED`、`CLOSED`。预设派生错误沿用 `PTC_PRESET_*`。

## 兼容性

1.0 移除了 0.x 的 `execution_bus` 工具、完整 v1 消息信封、`./core` 导出与旧预设 ID；工具与导出变更属于主版本破坏。0.12.1 是最后一个总线版本。
