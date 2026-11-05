# 萧何 / Xiao He

**PTC 多 Agent 编排：Lead 提交 DAG，独立只读 Worker 分工，运行时负责调度、落盘与恢复，Lead 负责修改与验收。**

当前 mode 从 PTC 原地派生，Lead 仍用 PTC；仓库 dsh-execution-bus、npm 包名、预设 ID `xiao-he-runtime` 保持不变，不新增 team 模式。多 Agent 编排能力随 1.4.0 发布；标准插件入口对含 `agent` 计划的拒绝边界不变，见下方安全兼容边界。历史 0.x 版本说明保留当时名称。

DSH 独立插件：`@feng0531/dsh-execution-bus` · 当前版本 **1.4.0**

> 1.0 起产品从“执行总线模式”切换为**声明式运行时**：`runtime_run` 接收 DAG 计划，运行时按依赖并行执行、对只读步骤重试、逐步落盘并支持重启后恢复。旧的 `execution_bus` 工具与 `./core` 导出已移除；0.12.1 是最后一个总线版本，仍可在 npm/git 历史中查看。

> **当前安全兼容边界：**标准 DSH 0.2.2-rc.1 没有“仅补查父级缺失策略且去重公共层”的公开接口。本插件入口未接入可信 `DelegationPolicyAdapter`，含 `agent` 的 run/resume 在执行前以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 拒绝；普通工具 DAG 不受影响。下述 Worker 执行能力仅适用于显式注入该适配器的受控宿主集成，测试适配器不是 rc.1 通用实现。不能通过删父策略、回放完整父链或修改已安装宿主绕过此门禁。

## 它解决什么问题？

模型提交**步骤和执行依赖**，不再需要在 `run_code` 里写循环、反复等待；运行时负责调度，但不保证副作用只发生一次：

| 问题 | 运行时处理 |
|---|---|
| 多个独立工具操作串行、慢 | 无依赖步骤并行执行（并发 1–4） |
| 步骤需要等待前置完成 | `depends_on` 建 DAG；仅 `agent` 步骤追加前置结果为不可信 JSON，其他工具不插值 |
| 需要独立上下文分工 | `tool:agent` 启动独立只读 Worker；输出仍需 Lead 核实 |
| 只读步骤偶发失败 | 仅 `read/glob/grep` 可配置失败重试 `retry`（0–3）；超时不重试，避免重叠调用 |
| 单步卡死 | 每步 `timeout_ms`（1s–600s） |
| 长任务跨步骤 | 默认同步等待；仅不含 Agent 的计划可用 `async:true` 返回 `runId`，用 `runtime_status/runtime_result` 取回 |
| 进程重启/崩溃 | 运行记录落盘，重启后标记 `interrupted`，`runtime_resume` 仅重排在途 `read/glob/grep`，未知 Agent 不重放 |
| 需要停止 | `runtime_cancel` 停止调度并传播取消 |

## 安装与启用

本版目标宿主为 **DSH 0.2.2-rc.1**、Cordis ~4.1.0、include ~1.1.0，DSH peer 精确锁定 0.2.2-rc.1，不推导兼容其他宿主版本。旧版 1.3.3 的宿主目标仍为 0.2.1-rc.5。依赖安全告警及验证边界见[宿主兼容性](<docs/host-compatibility.md>)。

```text
npm install --ignore-scripts @feng0531/dsh-execution-bus@1.4.0
```

从源码验证待发布版本时，先用 `npm run pack:candidate` 生成本地 tgz，在隔离配置安装，不替换日常 DSH；正式包可用性以 npm 公开元数据及对应 GitHub Release 为准。

将包加入目标 DSH 配置的 `dsh.profile.bundles`（或使用宿主插件管理器的 bundle 加载），加载后会出现独立预设 **xiao-he-runtime**。普通任务仍用原工具；预设不接管终端、编辑或全局工具，授权与沙箱由宿主管理。发布不会自动安装或重启你的 DSH。

## 工具

| 工具 | 作用 |
|---|---|
| `runtime_run` | 提交计划；默认等待完成返回步骤状态；仅不含 Agent 的计划支持 `async:true` 立即返回 `runId` |
| `runtime_status` | 无 `runId` 按本会话分页（`limit` 1–100，默认 20；`offset` 0–10000，默认 0）；带 `runId` 返回步骤状态（不含结果） |
| `runtime_result` | 读取已保存的步骤结果（单步 >64KiB 只返回 `truncated/bytes`） |
| `runtime_cancel` | 停止调度、传播取消 |
| `runtime_resume` | 显式恢复 `interrupted` 运行 |

## 计划示例

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

允许步骤：`read/glob/grep/edit/write/pwsh/agent`；`retry` 只允许 `read/glob/grep`。计划上限：32 步、64KiB、并发 1–4、超时 1s–600s。

### 结果按需读取

Lead 可用 `runtime_result({runId,stepId,offset,limit,hash})` 分页读取已保存结果：默认每页 2048、最多 4096 个 Unicode 码点；按 nextOffset 继续，拼接 page.text 后再解析 JSON。仅原 owner 可读，不恢复截断原文、不向 Worker 开放 runtime 工具。可选 executionSettled 区分本进程仍在收束与已收束；缺省为未知，不能证明普通工具退出。完整定义见[协议](<docs/protocol.md#结果分页与清理观察>)。

### 只读 Worker

含 `agent` 的计划不支持 `async:true` 或 service `background=true`：父调用 `exec.toolSet` 随外层工具批次返回而 dispose，不能安全 detach Worker。以 `RUNTIME_AGENT_ASYNC_UNSUPPORTED` 在创建 run/Worker 前预检拒绝；普通工具计划的 async 行为不变。

`agent` 的 `input` 为 `{"prompt":"核查指定模块并报告证据","access":"read","max_steps":12,"output_format":"report"}`；`access` 可省略，`max_steps` 为 1–32、默认 12。`output_format` 可选 `text` 或 `report`，省略保留旧文本行为；`report` 要求严格 JSON，包含 `outcome/summary/evidence/limitations` 与可选 `requestedDecision`，限制见[报告契约](<docs/protocol.md#结构化报告与追溯>)。不支持 `write` 访问或写入范围授权；非空 `write_scopes` 拒绝，空数组仅作兼容归一化。

运行时通过公开 `agents.create` 与 `agentPresets.composeFrom` 创建独立上下文 Worker，继承模型路由，但强制使用 `NativeToolExecutor`（不是 PTC）；同时设置宿主 `sandbox:read-only`、`approval:never`，guard 仅准入 `read/glob/grep` 并与父调用 admission identity 取交集。Worker 不可调用 `run_code`、命令、写入或递归委派，提示词不作为权限控制。

只读 Worker 可以并行，但任何 Agent 步骤都不与本 run 的直接写入/命令步骤同批执行；不锁跨 run 或外部写入。Agent 不 retry、不自动重放；子会话 ID 写入 checkpoint 并在摘要可见，`succeeded` 不是验收通过。依赖结果缺失、截断或追加后 prompt 超过 64KiB 时拒绝执行。返回保留原始 `output` 与 `verification:"not_independently_verified"`，report 模式另含解析后的 `report`；所有模式的追溯均通过步骤记录和摘要的可选 `workerTrace` 暴露，不进入 `results[step].value` 或依赖 JSON，也不占用旧的单步结果 64KiB 配额。追溯只标识运行时角色/输出契约、精确任务 prompt 与模型路由，不证明网络成功或验收；当前仅在任务启动前和 `whenIdle` 后更新 checkpoint，取消/中途崩溃可能仅有初始空 `requestModels`。`outcome` 不改变 DAG 成功条件，正常结束且格式合格的 `partial/blocked` 仍可放行依赖；依赖只代表顺序，不构成自动写入授权，须由 Lead 验收后另行修改。详见[协议](<docs/protocol.md#agent-步骤受控宿主集成>)。

### 任务关联与逐项自报

计划可选 `task_id`（字母开头的 1–64 位字母/数字/_-）和 `previous_run_id`。关联前驱时必须同 owner、同 task，且前驱已终态并完成清理；只关联历史，不复用结果、不自动恢复、不扩大授权，记录仍按既有保留策略清理。摘要返回可选 `taskId/previousRunId`。

report 模式可提供 `acceptance_criteria:[{id,description}]`（1–16 项、ID 唯一）；Worker 必须逐项返回 `criteria:[{id,status,evidence_indices,note}]`，状态仅 `observed/not_verified/blocked`，证据索引指向报告的 evidence。缺失、重复、未知 ID 或越界索引拒绝。逐项观察仍是自报，Lead 独立验收，不能将 `observed` 或格式校验通过当作 accepted。不提供契约时保持原报告形状。

## 语义与限制

- 同一记录 root 在单进程内分别共享最多 **8 个 active run** 和 **8 个 Worker**；`runtime_run` 与 `runtime_resume` 共用 run 准入。Worker 在创建前同步占槽，执行和 dispose 全程占用；满载步骤以 `RUNTIME_AGENT_CAPACITY_EXCEEDED` 失败，不隐式排队或自动重试。不同 root/进程不共用配额，不是跨进程锁。
- 只读工具重试根据结构化错误分类：明确权限、参数、资源不存在等确定性错误不重试，瞬态错误可重试；缺少结构化信息的未知错误保留旧重试行为，不解析错误正文猜测原因。退避为 100/200/400ms，可取消；超时仍不重试。
- 每步 checkpoint；记录在 `DSH_HOME/tmp/xiaohe-runtime/runs`（`XIAOHE_RUNTIME_DIR` 可覆盖），按会话隔离。默认保留最新 100 条终态，保护 `running/interrupted`。
- 取消停止调度，不保证普通工具实际停止或 rollback；Agent 取消/超时须等待 Worker dispose 后释放调度槽；`runtime_cancel` 仅发起取消，返回不证明清理完成，同步 run 或服务 dispose 才等待清理。**不保证 exactly-once**。恢复遇到未知副作用或未知 Agent 使整个 run `failed`，不再调新步骤。
- 同步 run/resume 绑定外层 signal；不含 Agent 的计划才可用 `async:true`，受理后脱离外层信号。`pwsh` 显式后台预检拒绝，自动转后台不算命令完成，保留 `jobId` 供原生 `job_output/job_kill` 收集。详见[协议与恢复边界](<docs/protocol.md>)。
- 运行时随宿主进程退出，不做跨进程执行或分布式队列。
- 计划质量是新的失败来源；稳定、可枚举的流程适合，探索型任务仍用原工具。

## 开发与验证

```text
npm ci --include=dev --ignore-scripts
npm run check          # build + 全量测试；结果以本次实际输出为准
npm run verify:package # 包白名单
npm run test:install   # 临时目录安装验证
```

桌面 UI、真实模型与实际沙箱仍未验收；测试范围与执行结果见[验证范围](<docs/validation.md>)。

## 文档

- [声明式运行时设计](<docs/DECLARATIVE-RUNTIME.md>)、[协议](<docs/protocol.md>)、[验证范围](<docs/validation.md>)、[产品结构](<docs/PRODUCT.md>)
- [运行状态与故障处置](<docs/OPERATIONS.md>)、[验收与对照试验](<docs/FLOW-TEST.md>)、[研发路线](<docs/DEVELOPMENT-PLAN.md>)
- [1.4.0 发布说明](<docs/releases/1.4.0.md>)、[发布流程](<docs/RELEASING.md>)、[第三方说明](<THIRD_PARTY_NOTICES.md>)
- 0.x 总线历史与复盘：[复盘](<docs/RETROSPECTIVE.md>)、[整合说明](<docs/INTEGRATION.md>)
