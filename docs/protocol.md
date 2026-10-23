# 协议与运行语义（1.0）

## 工具

| 工具 | 输入 | 返回 |
|---|---|---|
| `runtime_run` | `{ plan, async? }` | 同步：运行摘要与步骤状态；`async:true`：受理后立即返回 `{ runId, state:"running" }` |
| `runtime_status` | `{}`、`{ limit?, offset? }` 或 `{ runId }` | 本会话最近运行列表与脱敏存储诊断，或指定运行元数据（不含结果） |
| `runtime_result` | `{ runId }` | 运行摘要 + 已保存步骤结果（`truncated/bytes` 标记） |
| `runtime_cancel` | `{ runId }` | 取消调度后的运行摘要；不保证宿主操作已实际停止 |
| `runtime_resume` | `{ runId }` | 同步等待恢复结果；仅 `interrupted` 可恢复 |

列表 `limit` 为 1–100，默认 20；`offset` 为 0–10000，默认 0。先按所有者过滤，再按更新时间降序分页；同时间以运行 ID 稳定排序。指定 `runId` 时不能同时提供分页参数。所有工具拒绝未知字段。

## 计划（plan）

`plan = { goal?, concurrency?, steps[] }`；`step = { id, tool, input, depends_on?, retry?, timeout_ms? }`。

- 允许工具：`read/glob/grep/edit/write/pwsh`；`retry` 只允许 `read/glob/grep`（0–3）。普通只读失败可重试；超时不自动重试，避免上次调用未实际停止时发生重叠。
- 约束：1–32 步；计划 ≤64KiB；并发 1–4；单步超时 1s–600s；`id` 唯一、依赖必须存在、禁止环。
- `depends_on` 只表示成功后的执行顺序，不注入前一步结果；输入按宿主工具自身 schema、父调用权限和工作目录执行。
- 调度为有界批次：一批结束后才启动下一批。任一步失败后不再调度新批次；同批已开始的操作不保证回滚。
- 同一进程、同一规范化记录目录共享最多 8 个活跃运行；新建和恢复共用配额。

## 命令完成判定

- `pwsh` 必须返回已完成、退出码为 0、没有中断、超时、停止或沙箱拒绝的结果，才能放行依赖步骤。
- `input.run_in_background:true` 在计划受理前以 `RUNTIME_BACKGROUND_UNSUPPORTED` 拒绝，不启动任何步骤。
- 宿主自动转后台的 `promoted` 回执（或意外的 `background` 回执）不是命令完成：运行失败，命令步骤标 `unknown/RUNTIME_BACKGROUND_UNSUPPORTED`，下游不执行；结果中保留 `kind/jobId`，必须通过原生 `job_output/job_kill` 收集或停止宿主任务。运行时不自动重发，也不把取消运行等同于停止该 Job。

## 状态、取消与关闭

- 运行：`running | succeeded | failed | cancelled | interrupted`。
- 步骤：`pending | running | succeeded | failed | cancelled | unknown`。
- `unknown` 表示副作用是否完成无法确认，不是“未执行”；不自动重试或回滚。
- 同步 `runtime_run` 与 `runtime_resume` 绑定外层取消信号；`async:true` 受理成功后脱离外层等待信号，用 `runtime_cancel` 显式取消。
- 取消立即停止新步骤调度，并向在途工具传播信号；未开始步骤标 `cancelled`，已开始的副作用标 `unknown`。忽略取消的工具可能继续，晚到结果不覆盖已提交终态。
- 超时的副作用步骤标 `unknown/RUNTIME_STEP_TIMEOUT`，运行失败；超时只读步骤失败，不自动重试。
- 卸载关闭服务后拒绝新操作，取消并等待本作用域调度退出；不取消其他作用域拥有的运行，也不承诺强杀不合作的宿主操作。

## 持久化与恢复

- 记录路径：`DSH_HOME/tmp/xiaohe-runtime/runs/<runId>.json`（`XIAOHE_RUNTIME_DIR` 可覆盖）。每次工具尝试前、每步完成和重试时写检查点；同目录唯一临时文件替换，失败清理。原子替换不等于掉电耐久事务。
- 记录保留 version 1，新增可选进程所有权字段；新会话不会把本进程其他活跃运行误标中断。其他仍存活进程的记录保守跳过，不据此提供跨进程锁或分布式保证。
- 仅失联的 `running` 记录标 `interrupted`，在途步骤标 `unknown`；不自动执行恢复。
- 显式恢复保留已保存成功步骤，只读在途步骤重新排队；若存在未知副作用，标 `failed/RUNTIME_INTERRUPTED` 并停止整个恢复计划，不再启动任何新步骤。**不保证 exactly-once**。
- 默认持续保留最近 100 个终态运行（`succeeded/failed/cancelled`），不删除 `running/interrupted`。中断记录可能长期保留，应由所有者确认后取消；本轮不提供 TTL 或归档接口。
- status/result/cancel/resume 只允许所有者会话。单步结果 >64KiB 只保存截断标记；记录读取上限 4MiB，结构、计划、步骤、结果和时间戳不一致的记录隔离忽略。
- `runtime_status` 列表附 `diagnostics`：当前存储实例有界累计计数 `invalidRecords/oversizedRecords/readFailures/writeFailures`，不含记录路径或正文；重复扫描可重复计数，不代表损坏文件去重数量。
- 保存失败以 `RUNTIME_STORAGE_FAILED` 停止调度并尝试提交失败状态；若磁盘不可写，只能在进程内保留最多 100 个失败摘要，不能承诺重启后仍可查询。记录正文可能含敏感输入或结果，保管记录目录与权限仍是部署者责任。

## 错误码（运行时）

`INVALID_PLAN`、`PLAN_TOO_LARGE`、`PLAN_DUPLICATE_ID`、`PLAN_UNKNOWN_DEP`、`PLAN_CYCLE`、`PLAN_UNKNOWN_TOOL`、`PLAN_RETRY_DENIED`、`RUNTIME_NOT_FOUND`、`RUNTIME_INVALID_STATE`、`RUNTIME_STEP_TIMEOUT`、`RUNTIME_CANCELLED`、`RUNTIME_INTERRUPTED`、`RUNTIME_STEP_FAILED`、`RUNTIME_BUSY`、`RUNTIME_STORAGE_FAILED`、`RUNTIME_COMMAND_FAILED`、`RUNTIME_BACKGROUND_UNSUPPORTED`、`OWNING_SESSION_REQUIRED`、`CLOSED`。预设派生错误沿用 `PTC_PRESET_*`。

## 兼容性

1.0 移除了 0.x 的 `execution_bus` 工具、完整 v1 消息信封、`./core` 导出与旧预设 ID；工具与导出变更属于主版本破坏。0.12.1 是最后一个总线版本。本轮不变更包版本，不自动安装、重启或发布。
