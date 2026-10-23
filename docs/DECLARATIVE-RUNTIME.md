# 声明式运行时

> 1.0 已移除旧 `execution_bus` 工具、总线预设与 `./core` 导出；当前入口为 `runtime_*` 工具与 `xiao-he-runtime` 预设。

## 它是什么

模型不再在 `run_code` 里写循环/等待，而是提交一份**计划（plan）**：

```json
{
  "goal": "读取两个文件，完成后输出固定文本",
  "concurrency": 2,
  "steps": [
    { "id": "a", "tool": "read", "input": { "file_path": "README.md" } },
    { "id": "b", "tool": "read", "input": { "file_path": "package.json" } },
    { "id": "c", "tool": "pwsh", "input": { "description": "输出固定文本", "command": "echo ok" }, "depends_on": ["a", "b"] }
  ]
}
```

运行时负责：DAG 校验、独立步骤并行、只读失败重试、每步超时、结果落盘、取消与重启后恢复。`depends_on` 只约束执行顺序，不将前置步骤的结果注入 `input`；示例命令的输入是固定的。

## 工具

| 工具 | 作用 |
|---|---|
| `runtime_run` | 提交计划；默认等待完成并返回步骤状态，`async:true` 立即返回 `runId` |
| `runtime_status` | 无 `runId` 按本会话分页：`limit` 1–100（默认 20）、`offset` 0–10000（默认 0）；带 `runId` 返回步骤状态（不含结果），不能同时传分页参数 |
| `runtime_result` | 读取已保存的步骤结果（单步 >64KiB 只返回 truncated/bytes） |
| `runtime_cancel` | 停止调度、传播取消 |
| `runtime_resume` | 显式恢复 `interrupted` 运行；遇到未知副作用则整个 run 失败，不再启动新步骤 |

## 语义与边界

- 允许工具：`read/glob/grep/edit/write/pwsh`；`retry`（0–3）只允许 `read/glob/grep` 的普通失败。只读超时不重试，避免与不合作的原调用重叠。
- 计划上限：32 步、64KiB、并发 1–4、单步超时 1s–600s。
- 同一记录 root 在单进程内共享最多 8 个 active run，`runtime_run/runtime_resume` 均需准入；新建 service scope 不会把本进程活跃运行误判为中断。这不是跨进程锁或分布式配额。
- 每步调用前、完成与重试时写 checkpoint，不等整批结束；已落盘的成功步骤不重放。checkpoint 失败以 `RUNTIME_STORAGE_FAILED` 停止后续调度。
- 运行记录保存在 `DSH_HOME/tmp/xiaohe-runtime/runs`（可用 `XIAOHE_RUNTIME_DIR` 覆盖），按会话隔离。默认仅保留最新 100 条终态（`succeeded/failed/cancelled`），`running/interrupted` 不计入预算且不被清理；恢复可能扫描到更老记录。损坏、超大或不合法记录隔离忽略，列表返回脱敏诊断。
- 取消及时停止调度并传播 signal；不等待不合作工具真正退出，也不允许晚到结果改回成功。在途副作用可为 `unknown`，不表示已停止或 rollback。同步 run/resume 绑定外层 signal；`async:true` 成功接收后脱离外层信号，不代表脱离宿主进程。
- 崩溃/重启后遗留运行标记 `interrupted`，在途步骤 `unknown`。**不保证 exactly-once**：副作用可能已发生；恢复遇到未知副作用将步骤标为 `failed/RUNTIME_INTERRUPTED`、整个 run 标为 `failed`，不调度包括无关 pending 在内的新步骤。不存在失败时才重排在途只读步骤。
- `pwsh` 显式 `run_in_background:true` 在执行前预检拒绝（`RUNTIME_BACKGROUND_UNSUPPORTED`）；非零退出、超时/中止或沙箱失败不算命令成功。宿主自动转后台时 run 为 `failed`、步骤为 `unknown`，结果保留 `kind/jobId`；须用原生 `job_output/job_kill` 收集或停止 Job，不能把后台回执称为命令完成。
- 不做跨进程执行、不做分布式队列；运行时随宿主进程退出。
- 计划质量是新的失败来源；稳定、可枚举的流程适合，探索型任务仍用 PTC 原工具。

## 与旧 execution_bus 的关系

旧总线的 requestId 去重、预算分离等待与宿主 Job 投影属于 0.x 历史接口，不与当前运行时共存。0.12.1 是最后一个总线版本；旧版本说明保留在 npm/git 历史，不能作为当前 `runtime_*` 契约。
