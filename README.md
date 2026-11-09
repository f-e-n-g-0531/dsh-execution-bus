# 萧何 / Xiao He

**声明式工具 DAG：运行时负责调度、落盘与恢复，Lead 负责修改与验收。独立只读 Worker 目前仅限可信适配器集成，标准 rc.1 插件入口不可用。**

当前 mode 从 PTC 原地派生，Lead 仍用 PTC；仓库 dsh-execution-bus、npm 包名、预设 ID `xiao-he-runtime` 保持不变，不新增 team 模式。多 Agent 编排能力随 1.4.0 发布；标准插件入口对含 `agent` 计划的拒绝边界不变，见下方安全兼容边界。历史 0.x 版本说明保留当时名称。

DSH 独立插件：`@feng0531/dsh-execution-bus` · 当前版本 **1.7.0**

1.7.0 新增任务与跨任务查询、成员快照分页、决策处置、显式交接与通知回执，改进纯只读 DAG 调度，并提供可信宿主扩展及离线业务提示词历史。安全门禁与未知副作用不重放规则不变；见[发布说明](<docs/releases/1.7.0.md>)。发布不自动安装或重启日常 DSH。

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
| 长任务跨步骤 | 默认同步等待；仅不含 Agent 且调用未携带 `exec.toolSet` 的受控宿主计划可用 `async:true` 返回 `runId`，用 `runtime_status/runtime_result` 取回 |
| 进程重启/崩溃 | 运行记录落盘，重启后标记 `interrupted`，`runtime_resume` 仅重排在途 `read/glob/grep`，未知 Agent 不重放 |
| 需要停止 | `runtime_cancel` 停止调度并传播取消 |

## 安装与启用

本版目标宿主为 **DSH 0.2.2-rc.1**、Cordis ~4.1.0、include ~1.1.0，DSH peer 精确锁定 0.2.2-rc.1，不推导兼容其他宿主版本。旧版 1.3.3 的宿主目标仍为 0.2.1-rc.5。依赖安全告警及验证边界见[宿主兼容性](<docs/host-compatibility.md>)。

```text
npm install --ignore-scripts @feng0531/dsh-execution-bus@1.7.0
```

从源码验证待发布改动时，先用 `npm run pack:candidate` 生成本地 tgz，在隔离配置安装，不替换日常 DSH；正式包可用性以 npm 公开元数据及对应 GitHub Release 为准。

将包加入目标 DSH 配置的 `dsh.profile.bundles`（或使用宿主插件管理器的 bundle 加载），加载后会出现独立预设 **xiao-he-runtime**。普通任务仍用原工具；预设不接管终端、编辑或全局工具，授权与沙箱由宿主管理。插件列表显示名为 **萧何 / Xiao He**（宿主 locale meta；中文资源文件为 `locale/zh.json`）；仓库名、npm 包名、预设 ID 和工具名等技术标识不变。

发布不会自动安装或重启你的 DSH。

## 工具

| 工具 | 作用 |
|---|---|
| `runtime_capabilities` | `{}` 查询能力说明；不是授权、容量预留或真实模型可用性检查 |
| `runtime_run` | 提交计划；默认等待完成返回步骤状态；仅不含 Agent 且调用未携带 `exec.toolSet` 的受控宿主计划支持 `async:true` 立即返回 `runId` |
| `runtime_status` | 无 `runId` 按本会话分页（`limit` 1–100，默认 20；`offset` 0–10000，默认 0）；带 `runId` 返回步骤状态（不含结果） |
| `runtime_result` | 读取已保存的步骤结果（单步 >64KiB 只返回 `truncated/bytes`） |
| `runtime_acknowledge` | 原 owner 显式知悉当前版本的问题；不隐藏风险、不等于解决或验收，未知副作用仍提醒 |
| `runtime_review` | 为完整成功且已收束的运行记录 owner 处置，绑定结果快照与 revision；不是人工或独立验收证明 |
| `runtime_cancel` | 停止调度、传播取消 |
| `runtime_resume` | 显式恢复 `interrupted` 运行 |

## 行动摘要、任务视图与通知回执（1.7.0）

以下能力随 1.7.0 提供；发布不会自动安装到日常 DSH。

1. 摘要和列表项增加 `action:{kind,actor,message}`，卡片展示下一步行动，仅派生建议。
2. `runtime_task({taskId,limit?,offset?})` 查询同 owner、同任务保留运行及本页待办计数，不是完整历史；与 `runtime_status` 列表均新增成员快照分页，旧 offset 分页保持不变。
3. `runtime_notification` 提供显式通知回执：get → sync → claim → 宿主投递 → settle。新内容合并，旧回调拒绝，不自动发送或重跑 DAG。
4. 包入口导出 `RuntimeService` 和 `NotificationSender` 类型，宿主可显式调用 `service.deliverNotification(runId, ownerExec, sender)`；只对 pending 回执投递一次，使用稳定 messageId，sender 返回 sent/not_sent/unknown。异常、未知或发送后取消保留 delivering，不自动重发；failed 需走回执协议显式核验处置。sender 由宿主绑定渠道和授权，不开放给模型。
5. sent 仅为投递方声明，不证明实际送达、阅读、处理、交付或验收；delivering 崩溃遗留先核验渠道，不自动重发。
6. 模型接口契约测试检查实际注册工具、输入/输出 schema、固定提示词、安全措辞和文本体积预算；任务卡片保留任务 ID、前次运行及下一步行动。
7. RuntimeService 对规范化记录目录取得进程级独占锁；同模块同进程共享，其他持锁者拒绝 RUNTIME_ROOT_LOCKED。崩溃遗留锁不自动抢占，停机核验后手动处置；底层 RunStore/旧版/外部写入不受此合作锁保护。
8. 存储诊断保留累计计数，并增加实例统计起点、快照观察时间和各类最近错误观察时间；不持久化、不包含路径正文，也不表示故障仍持续或已经恢复。

9. `runtime_status` 列表与 `runtime_task` 可用 `snapshot:true` 获取首屏，或以 `cursor:<nextCursor>` 续页（`limit` 1–100，默认 20）。snapshot/cursor 均与 offset 互斥，cursor 与 snapshot 互斥；status 的 runId 模式不接受快照参数。捕获时按 `updatedAt_desc_runId_asc` 固定成员及顺序，返回 `order:"snapshot_membership"`；不冻结状态，每页重读 owner 记录，新增不插队。清理或不可读的成员显式列于 `pagination.missingRunIds`，不补位。`pagination` 含 `mode:"snapshot"/capturedAt/expiresAt/total/nextCursor?`（total 为捕获成员数）。快照有效 5 分钟，每 RuntimeService 实例最多 16 份（容量满淘汰旧快照），每份最多 1000 ID，超过单份上限拒绝；过期、重启、服务销毁或淘汰后报 `RUNTIME_NOT_FOUND`，需重新 `snapshot:true`，不承诺全量历史，也不要与活动 offset 页直接拼接。
10. plan 新增可选 `provenance:{request_ref?,scope_summary?,context_refs?}`，至少一字段；文本 trim 后非空，长度上限分别为 1000/2000/每条 1000（UTF-16 code units，按原字符串计），refs 为 1–8 条，未知键拒绝。仅说明来源与范围、不授权、不自动抓取引用、不作为 Worker 指令；按 owner 隔离存储，run/task 卡分栏展示来源信息，缺失显示“未提供”。

11. 完整 `runtime_result({runId})` 新增只读 `planComparison`，按步骤 ID 比较显式前驱的计划，展示新增、删除和字段变化；输入只报是否变化，不展示正文或哈希。前驱不可用时明确不可比较，不跨缺口比较、不复用结果、不授权或自动执行；列表、状态与结果分页不增加前驱读取。

简短使用示例（1.7.0 接口）：

```ts
const first = await tools.runtime_status({snapshot:true, limit:20});
if (first.pagination.nextCursor) {
  const next = await tools.runtime_status({cursor:first.pagination.nextCursor, limit:20});
  console.log(next.runs, next.pagination.missingRunIds);
}
const task = await tools.runtime_task({taskId:"audit", snapshot:true, limit:20});
// 任务续页保留同一 taskId，并传 task.pagination.nextCursor，不传 snapshot/offset。
```

完整参数及存储边界见[协议](<docs/protocol.md#行动摘要任务视图与通知回执源码新增>)；计划来源示例见[provenance 契约](<docs/protocol.md#计划来源说明源码新增>)。

### 跨任务待办与历史检索（1.7.0）

当前源码新增只读工具 `runtime_query`，在同 owner 的保留运行内先筛选再分页：

```ts
await tools.runtime_query({view:"needs_action"}); // 跨任务必须处理事项
await tools.runtime_query({view:"review"});       // 结果待复核，单独分组
await tools.runtime_query({q:"issue:42", taskId:"audit", state:"failed", limit:20});
```

`q` 仅检索目标与 provenance，支持大小写不敏感的字面子串；不检索输入或结果正文。返回摘要、筛选后运行数和互斥分组计数，不自动执行或恢复。候选上限 1000，超限拒绝，不静默截取近期记录；每次查询重算，offset 翻页不冻结成员。完整参数、计数与诊断边界见[查询协议](<docs/protocol.md#跨任务待办与历史元数据检索源码新增未发布>)。

### 显式交接与离线提示词历史（1.7.0）

1. `runtime_handoff` 为同 owner、同任务的终态源运行生成所选结果的版本绑定交接摘要；显式放入后继 `plan.handoff` 才保存。提交与恢复重验来源及结果哈希，来源缺失或变化拒绝。摘要是不可信资料，不自动注入 Worker、不复用执行成功、不扩大授权。
2. 包入口导出 `BusinessPromptHistory`，由可信宿主指定目录保存最多 32 个离线业务提示词修订，支持历史读取、revision 冲突检查及 `defaultChanges(revision)` 旧业务默认正文比较（缺失保持 unknown）。不注册模型工具、不应用到 Worker，不提供安全段覆盖。

参数、保留及恢复边界见[交接协议](<docs/protocol.md#跨-run-显式上下文交接源码新增未发布>)与[提示词历史](<docs/protocol.md#离线业务提示词版本历史源码新增未发布>)。

### 决策处置关联（1.7.0）

新增 `runtime_decision`，区分“已知悉”与“已记录答复 / 被替代 / 不再处理”。读取完整报告和证据后，由原 owner 对当前问题版本显式留痕，可附答复引用和已存在的后继运行；不是用户批准、问题已解决或验收证明，不回答活 Worker，不自动续跑或改变授权。摘要保留处置状态，完整历史从 `runtime_result` 读取；版本变化后重新待处理。参数与示例见[协议](<docs/protocol.md#决策处置关联源码新增未发布>)。

### 纯只读 DAG 调度（1.7.0）

整份计划仅含 `read/glob/grep` 时，步骤完成且结果落盘后立即用空槽调度已满足依赖的步骤，不再等待同批慢步骤；并发上限不变，重试退避仍占槽，失败、超时、取消或存储故障停止新派发。含 `agent/edit/write/pwsh` 的整份计划保持原批次调度与隔离规则。本项不增加持久队列或自动恢复，发布不会自动安装到日常 DSH。

### 共享容量观察（1.7.0）

`runtime_capabilities({})` 新增 `capacity:{scope:"module_process_root",observedAt,capacityBusy}`，只说明同模块、同进程、同规范化运行根目录的运行准入是否已满，不显示其他 owner、run、任务或精确占槽数。false 仅表示观察时未满，不保证下一次执行成功；不预留容量、不排队、不授权，也不要据此轮询或自动重试。

可信宿主可通过已持有的 `RuntimeService` 调用 `service.capacity()`，取得 `CapacitySnapshot`：`occupiedRuns/executingRuns/cleanupRuns/runLimit/workersInUse/workerLimit` 及范围和观察时间。executingRuns（含已准入恢复的初始化窗口）与终态尚未收束的 cleanupRuns 合计为 occupiedRuns；Worker 占槽包含创建、执行和清理。该宿主方法不注册模型工具，不读取磁盘或调用父策略；宿主须自行限制谁可查看精确聚合，不得原样转发给普通 owner。计数不是普通宿主调用或后台 Job 的实际存活统计，零值不证明其已停止；Worker 上限不表示标准插件已可运行 Worker。销毁后的服务拒绝查询，快照不持久化；原准入上限与满载即拒绝规则不变。

### 可信宿主扩展与离线预览（1.7.0）

可信宿主可通过 RuntimeService 第四个构造参数提供 WorkerHostOptions：显式绑定已获父级准入的 runtime_dependency_read 工具后，上游完整结果改为有界预览及版本绑定引用，按需分页；默认仍全文注入，缺失/截断仍拒绝。可选 onModelWait 回调仅观察宿主实际模型重试事件，不改变策略；rc.1 不保证发出这些事件，无状态不是健康证明。标准插件不配置这些选项，Worker 门禁保持不变。

包入口另导出 createBusinessPromptOverrides、previewBusinessPrompt、compareBusinessPrompts，仅离线检查 communication/delivery 业务段及默认值漂移，不应用到 Worker、不自动保存或授权；持久历史须显式使用 BusinessPromptHistory。完整宿主契约见[协议](<docs/protocol.md#可信宿主-worker-扩展与离线提示词预览源码新增>)。

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

### 能力、恢复与待复核结果

```ts
const caps = await tools.runtime_capabilities({});
console.log(caps.ordinaryDag, caps.worker, caps.ordinaryAsync, caps.workerAsync);
const saved = await tools.runtime_result({ runId }); // 使用已返回的 runId
console.log(saved.recovery, saved.acceptance);
```

`ordinaryDag:"supported"` 仍须每次通过宿主准入；仅同时存在可信 `DelegationPolicyAdapter` 和父 `toolSet` 时，`worker` 才为 `conditional`，否则为 `unavailable`，不代表适配器已修复或真实模型可用。普通 DAG 异步仅在无 `toolSet` 时允许，`workerAsync` 始终为 false；不得删除准入集合绕过限制。

单 run 摘要（run/status/result/cancel/resume）新增 `recovery`，区分结果记录确定性、本进程清理观察及建议下一步；`externalWork` 始终为 `unconfirmed`，`cleanup:"settled"` 不证明外部 Job 停止。`runtime_result`（包括分页）另含 `acceptance:{status:"not_reviewed",workers:[...]}`：只汇总 Worker 状态、结果哈希及报告计数，不回显报告自由文本；原始证据仍从保存结果读取。`resultHash` 绑定步骤 value 的 JSON 输出，不是验收；不持久化独立验收记录，不允许 Worker 自授 accepted，Lead 复核仍在上层。无 Worker 时空数组也不证明任务通过。字段与异常判读见[协议](<docs/protocol.md>)和[故障处置](<docs/OPERATIONS.md>)。

### 结果按需读取

Lead 可用 `runtime_result({runId,stepId,offset,limit,hash})` 分页读取已保存结果：默认每页 2048、最多 4096 个 Unicode 码点；按 nextOffset 继续，拼接 page.text 后再解析 JSON。仅原 owner 可读，不恢复截断原文、不向 Worker 开放 runtime 工具。可选 executionSettled 区分本进程仍在收束与已收束；缺省为未知，不能证明普通工具退出。完整定义见[协议](<docs/protocol.md#结果分页与清理观察>)。

### 只读 Worker

含 `agent` 的计划不支持 `async:true` 或 service `background=true`：父调用 `exec.toolSet` 随外层工具批次返回而 dispose，不能安全 detach Worker。以 `RUNTIME_AGENT_ASYNC_UNSUPPORTED` 在创建 run/Worker 前预检拒绝；普通工具计划若携带 `exec.toolSet`，异步或 service 后台提交也在创建 run 前以 `RUNTIME_ASYNC_ADMISSION_UNSUPPORTED` 拒绝；请使用同步调用，不得删除准入集合绕过限制。

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
- 同步 run/resume 绑定外层 signal；仅不含 Agent 且未携带批次准入集合的受控宿主调用才可用 `async:true`，受理后脱离外层信号。`pwsh` 显式后台预检拒绝，自动转后台不算命令完成，保留 `jobId` 供原生 `job_output/job_kill` 收集。详见[协议与恢复边界](<docs/protocol.md>)。
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

- [Superagent 原型完整对照与结案边界](<docs/SUPERAGENT-COMPARISON.md>)：固定参考版本的覆盖、采用与不采用理由；后续会话先查此记录，不重复提出同一批建议。

- [声明式运行时设计](<docs/DECLARATIVE-RUNTIME.md>)、[协议](<docs/protocol.md>)、[验证范围](<docs/validation.md>)、[产品结构](<docs/PRODUCT.md>)
- [运行状态与故障处置](<docs/OPERATIONS.md>)、[验收与对照试验](<docs/FLOW-TEST.md>)、[研发路线](<docs/DEVELOPMENT-PLAN.md>)
- [1.7.0 发布说明](<docs/releases/1.7.0.md>)、[1.6.0 发布说明](<docs/releases/1.6.0.md>)、[1.5.0 发布说明](<docs/releases/1.5.0.md>)、[1.4.1 发布说明](<docs/releases/1.4.1.md>)、[发布流程](<docs/RELEASING.md>)、[第三方说明](<THIRD_PARTY_NOTICES.md>)
- 0.x 总线历史与复盘：[复盘](<docs/RETROSPECTIVE.md>)、[整合说明](<docs/INTEGRATION.md>)
