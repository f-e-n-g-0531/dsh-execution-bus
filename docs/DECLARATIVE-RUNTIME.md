# 声明式运行时与多 Agent 编排

当前 mode 从 PTC 原地派生，预设 ID 仍为 `xiao-he-runtime`，不新增 team 模式。多 Agent 扩展随 1.4.0 发布；真实模型、UI 和 OS 沙箱尚未验收。

> 1.0 已移除旧 `execution_bus` 工具、总线预设与 `./core` 导出；当前入口为 `runtime_*` 工具与 `xiao-he-runtime` 预设。

> **当前安全兼容边界：**标准 DSH 0.2.2-rc.1 没有“仅补查父级缺失策略且去重公共层”的公开接口。本插件入口未接入可信 `DelegationPolicyAdapter`，含 `agent` 的 run/resume 在执行前以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 拒绝；普通工具 DAG 不受影响。下述 Worker 执行能力仅适用于显式注入该适配器的受控宿主集成，测试适配器不是 rc.1 通用实现。不能通过删父策略、回放完整父链或修改已安装宿主绕过此门禁。

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

运行时负责：DAG 校验、独立步骤并行、`read/glob/grep` 失败重试、每步超时、结果落盘、取消与重启后恢复。普通工具的 `depends_on` 只约束执行顺序，示例命令输入仍是固定的；只有 `agent` 步骤接收追加至 prompt 的直接依赖结果（不可信 JSON）。

Lead 仍用 PTC 拆分任务，通过 `runtime_run` 的 `tool:agent` 启动独立上下文只读 Worker，再核实输出并负责修改、验收。Worker 由公开 `agents.create` + `agentPresets.composeFrom` 创建并继承模型路由，强制 `NativeToolExecutor`（不是 PTC）；同时设置宿主 read-only 沙箱、approval never，guard 仅准入 `read/glob/grep` 且与父 admission identity 取交集。Worker 不可使用 `run_code`、命令、写入或递归委派；提示词不是权限边界。

Agent 输入为 `{prompt, access?:"read", max_steps?:1..32, output_format?:"text"|"report"}`，默认 12 步；`output_format` 省略保留旧文本行为，`report` 要求严格 JSON 报告（`outcome/summary/evidence/limitations` 与可选 `requestedDecision`），总计不超过 16KiB。不提供 write 或写入范围授权，非空 `write_scopes` 拒绝，空数组仅作兼容归一化。直接依赖结果缺失/截断或追加后 prompt >64KiB 拒绝执行，不向其他工具插值。含 Agent 的计划不支持 `async:true` 或 service `background=true`，以 `RUNTIME_AGENT_ASYNC_UNSUPPORTED` 在创建 run/Worker 前拒绝；父 `exec.toolSet` 随外层工具批次返回而 dispose，不能安全 detach Worker。普通工具计划若携带 `exec.toolSet`，异步或 service 后台提交也在创建 run 前以 `RUNTIME_ASYNC_ADMISSION_UNSUPPORTED` 拒绝；宿主批次结束会销毁该准入集合，没有公开续租接口。不得删除准入集合或重新解析以绕过限制；请使用同步调用。Agent 不 retry、不自动重放；子会话 ID 写入 checkpoint 并在摘要可见。`whenIdle` 后检查结束事件与最终文本，执行 `succeeded` 不代表内容验收通过。完整示例与错误码见[协议](<protocol.md#agent-步骤受控宿主集成>)。

报告模式保留原始 `output` 与 `verification:"not_independently_verified"`，另返回解析的 `report`；所有模式均通过步骤记录和摘要的可选 `workerTrace` 暴露追溯；`results[step].value` 仅含 `sessionId/output/verification` 与 report 模式的 `report`，不含 trace。追溯不进入依赖 JSON，也不占用原有单步结果 64KiB 配额。`promptVersion/promptHash` 仅追溯运行时角色与输出契约，不是完整宿主 prompt；`taskPromptHash` 覆盖追加依赖后的精确任务 prompt。`selectedModel` 是创建时选择，`requestModels` 是 `request/header` 记录的连续去重 resolved routes，不是请求次数或网络成功凭证。仅任务启动前和 `whenIdle` 后写追溯 checkpoint，取消/中途崩溃可能只有初始空 `requestModels`，不证明从未请求模型。

报告 evidence 仅自报，不打开文件核实、不产生授权或独立验收；`completed/partial/blocked` 不改变 DAG success 条件，正常结束且格式合格的报告仍可放行依赖。下游只代表顺序，不代表报告授权自动写入；Lead 核实后另行修改。完整限制见[结构化报告与追溯](<protocol.md#结构化报告与追溯>)。

运行时还提供以下约束与关联能力：同 root 跨 run 共享最多 8 个 Worker（创建、执行、dispose 全程占槽，满载失败而不隐式排队）；只读工具按结构化错误决定重试，退避 100/200/400ms 并响应取消。计划可选 task_id/previous_run_id 关联同 owner、同 task 的已结束并清理完成的前驱，不复用结果或扩大权限。report 模式可选 acceptance_criteria，要求每项恰好一条自报观察结果；这不是独立验收，也不改变 DAG 成功条件。完整限制见[协议](<protocol.md>)。

## 工具

提交与结果读取使用 `runtime_run/runtime_status/runtime_result`；取消和恢复使用 `runtime_cancel/runtime_resume`。能力查询、任务视图、决策处置、复核、交接与通知回执等完整工具清单及参数见[协议](<protocol.md#工具>)，入门示例见 [README](<../README.md#第一次使用>)。

## 语义与边界

- 允许步骤：`read/glob/grep/edit/write/pwsh/agent`；`retry`（0–3）只允许 `read/glob/grep` 的普通失败。只读超时不重试，避免与不合作的原调用重叠。
- 计划上限：32 步、64KiB、并发 1–4、单步超时 1s–600s。只读 Worker 可并行，但 Agent 与本 run 的直接写入/命令步骤批次隔离，不锁跨 run 或外部写入。
- 同一记录 root 在单进程内共享最多 8 个 active run，`runtime_run/runtime_resume` 均需准入；新建 service scope 不会把本进程活跃运行误判为中断。这不是跨进程锁或分布式配额。
- 每步调用前、完成与重试时写 checkpoint，不等整批结束；已落盘的成功步骤不重放。checkpoint 失败以 `RUNTIME_STORAGE_FAILED` 停止后续调度。
- 运行记录保存在 `DSH_HOME/tmp/xiaohe-runtime/runs`（可用 `XIAOHE_RUNTIME_DIR` 覆盖），按会话隔离。默认仅保留最新 100 条终态（`succeeded/failed/cancelled`），`running/interrupted` 不计入预算且不被清理；恢复可能扫描到更老记录。损坏、超大或不合法记录隔离忽略，列表返回脱敏诊断。
- 取消及时停止调度并传播 signal；Agent 取消/超时由同步 run/服务 dispose 等待 Worker dispose；`runtime_cancel` 仅发起取消，返回不证明已清理，普通工具不等待不合作工具真正退出，也不允许晚到结果改回成功。在途副作用可为 `unknown`，不表示已停止或 rollback。同步 run/resume 绑定外层 signal；仅不含 Agent 且调用未携带 `exec.toolSet` 的受控宿主计划可用 `async:true`，受理后脱离外层信号，不代表脱离宿主进程。
- 崩溃/重启后遗留运行标记 `interrupted`，在途步骤 `unknown`。**不保证 exactly-once**：副作用可能已发生；恢复遇到未知副作用或未知 Agent 将步骤标为 `failed/RUNTIME_INTERRUPTED`、整个 run 标为 `failed`，不调度包括无关 pending 在内的新步骤。不存在失败时才重排在途 `read/glob/grep` 步骤。
- `pwsh` 显式 `run_in_background:true` 在执行前预检拒绝（`RUNTIME_BACKGROUND_UNSUPPORTED`）；非零退出、超时/中止或沙箱失败不算命令成功。宿主自动转后台时 run 为 `failed`、步骤为 `unknown`，结果保留 `kind/jobId`；须用原生 `job_output/job_kill` 收集或停止 Job，不能把后台回执称为命令完成。
- 不做跨进程执行、不做分布式队列；运行时随宿主进程退出。
- 计划质量是新的失败来源；稳定、可枚举的流程适合，探索型任务仍用 PTC 原工具。

## 与旧 execution_bus 的关系

旧总线的 requestId 去重、预算分离等待与宿主 Job 投影属于 0.x 历史接口，不与当前运行时共存。0.12.1 是最后一个总线版本；旧版本说明保留在 npm/git 历史，不能作为当前 `runtime_*` 契约。
