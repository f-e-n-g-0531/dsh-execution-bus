# 验证范围与使用限制

本文说明证据边界，不是生产环境认证。当前公开基线为 **v1.3.2**（提交 `8d1a5bf`），已于 2026-11-04 发布至 [npm](https://registry.npmjs.org/@feng0531/dsh-execution-bus/1.3.2) 和 [GitHub Release](https://github.com/f-e-n-g-0531/dsh-execution-bus/releases/tag/v1.3.2)，交付范围见[发布说明](<releases/1.3.2.md>)；v1.3.0 是历史研发起点，v1.3.2 生产运行时与 v1.3.1 一致；版本发布不代表下述真实环境验收已经完成。v1.4.0 依赖目标为 **DSH 0.2.2-rc.1**、Cordis ~4.1.0、include ~1.1.0、Node ≥22；包版本为 1.4.0，多 Agent 编排随本版发布，公开 1.3.3 的原包兼容范围不因本次适配而改变，兼容范围见[宿主兼容性](<host-compatibility.md>)。历史 v1.2.0 的 Windows、Node.js 24.21.0、DSH rc.2 组件验证记录只属于当时版本，不能代替 rc.1 工作树候选的复核。后续研发与真实验收门禁见[研发计划](<DEVELOPMENT-PLAN.md>)。

公开版本验证只属于其原始候选；工作树或包内容变化后须重新绑定候选 SHA，不沿用公开包验证结论。环境与预算按[研发准备记录](<RESEARCH-READINESS.md>)确认，模板完整不代表已验收。

## 多 Agent 工作区扩展的证据状态

> **当前安全兼容边界：**标准 DSH 0.2.2-rc.1 没有“仅补查父级缺失策略且去重公共层”的公开接口。本插件入口未接入可信 `DelegationPolicyAdapter`，含 `agent` 的 run/resume 在执行前以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 拒绝；普通工具 DAG 不受影响。下述 Worker 执行能力仅适用于显式注入该适配器的受控宿主集成，测试适配器不是 rc.1 通用实现。不能通过删父策略、回放完整父链或修改已安装宿主绕过此门禁。

多 Agent 改造随 1.4.0 发布；验证结论只属于 1.4.0 原始候选，不沿用公开包或旧候选的验证结论。沿用 PTC 派生的 `xiao-he-runtime`；Lead 仍用 PTC，独立 Worker 强制 NativeToolExecutor，不是 PTC Worker。

2026-11-05 整改前一轮先执行 `npm run check`：构建及 308/308 测试通过。独立复核随后发现并修复 trace 占用旧文本结果配额的问题，增加临界回归，当时共 309 项（相对此前 289 项基线新增 20 项）。修复后两次默认并行全测均为 308 通过、1 失败、0 跳过：分别在 continuous completion / offline cancellation 存储保留用例出现 `RUNTIME_STORAGE_FAILED`；单独复跑 `test/runtime-service.test.mjs` 为 15/15 通过。随后执行 `node --test --test-concurrency=1 test/*.test.mjs` 串行全测为 **309/309 通过，0 失败、0 跳过**，并再次通过 95 个包文件核验。当前不能判定并行失败根因，也不声称默认并行全测稳定通过；串行通过不抵销该限制。`npm run verify:package` 检查 95 个包文件通过，`tsc --noEmit`、28 个编译产物内存对比及 `git diff --check` 通过。

新增回归覆盖严格协议边界、插件与 mode 入口、兼容文本与依赖上下文预算、错误清理及持久化校验；模型响应与部分工具仍为离线夹具，不代表真实模型调用、完整 PTC→runtime_run→Worker 桌面链路或 OS 沙箱攻击验证。本轮环境为 Windows、Node v26.13.0，不推导其他平台或最低 Node 版本已通过。此记录仅属于本轮工作区，不可沿用为公开 npm 包验收。

本次原型借鉴整改新增同 root 的 8 Worker 生命周期配额、结构化错误分类/100–400ms 退避、task_id/previous_run_id 关联，以及可选 acceptance_criteria 逐项自报；不引入长期工单系统、不自动验收、不扩大权限。专项回归包含真实宿主创建 pending/取消/超时/dispose drain、同 root 多 service 配额与不同 root 隔离，报告→磁盘 reload→下游 Worker，以及 canonical host error.info.code 经 PTC/native 管线保留的分类边界。宿主不保留的原始 status/errno 仍不可用；未知普通错误保留旧 retry。

首轮 339 项中 338 通过，唯一失败为旧 PTC 缺失文件测试仍要求 retry；本次策略明确 FS_NOT_FOUND 不重试，已将该测试改为单次失败并继续阻断下游写入，真实 PTC 定向复跑通过。其后默认并行 344 项中 343 通过，offline cancellation 存储保留测试再现 RUNTIME_STORAGE_FAILED；未修改或掩盖存储 fail-stop，根因仍未确认。随后串行全测 346/346 通过、0 失败/跳过（当轮包含之后追加中的边界测试，最终数量以最终门禁输出为准）；单独配额生命周期8/8与任务关联4/4通过。一次真实宿主报告组合测试初版因夹具缺少agents注入而失败，补注入后通过；新增schema断言曾将正常空错误数组误写成undefined，已修正为[]并复跑通过。这些夹具纠正不作为生产功能BUG。最终 `npm run check`（重新构建 + 默认并行全测）为 **347/347 通过、0 失败、0 跳过**，`npm run verify:package` 为 **99 个文件通过**，`tsc --noEmit`、32 个编译产物内存比较与 `git diff --check` 通过。最后一次通过不抵销此前间歇性存储失败，不能据此宣布其根因已解决。

本轮安全整改移除完整父策略链回放，新增显式可信适配器门禁；当前 rc.1 标准入口拒绝 Worker，不能将受控 fixture 的 allow 适配器当作宿主实现。新增回归检查普通/global:true hook 与 global guard 各一次、父局部 deny/ask/cancel/throw、子局部 deny、缺失适配器零创建/零模型请求；另检查 Lead 结果分页的 owner 隔离、Unicode 拼接、hash 和截断拒绝，以及取消后 executionSettled 直到清理收束才变化。存储仅保留原始 cause 供本地诊断，未盲加重试，间歇失败根因仍未证实。本轮重新构建后的默认并行全测为 **357/357 通过、0 失败、0 跳过**；随后补充的分页 EOF、磁盘 reload 和展示元数据隐私断言定向 2/2 通过；`npm run verify:package` 99 个文件通过，`tsc --noEmit` 和 `git diff --check` 通过。此结果不抵销历史间歇存储失败，也不证明真实模型、UI 或 OS 沙箱已验收。

多 Agent 扩展的回归检查范围：

- `agent` 只读输入与默认 12/上限 32 步，拒绝 write、非空 write_scopes、未知字段与非零 retry；空 write_scopes 仅作兼容归一化，不提供写权限。
- 公开 agents.create/composeFrom、独立上下文和模型路由；read-only 沙箱 + approval never、NativeToolExecutor、guard 的 read/glob/grep 白名单与父 admission identity 交集。拒绝 run_code、命令、写入及递归委派，不能把提示词当权限。
- 含 Agent 的计划以 async:true 或 service background=true 提交，在创建 run/Worker 前报 `RUNTIME_AGENT_ASYNC_UNSUPPORTED`；父 exec.toolSet 随外层工具批次返回而 dispose，不能安全 detach Worker；普通工具 async 不变。
- 可选 `output_format:report` 严格 JSON、16KiB UTF-8 上限、证据与状态约束、未知字段拒绝；`partial/blocked` 只是 Worker 自报结果，不改变执行成功或授予写权限，所有模式保留未独立验收标记。
- `workerTrace` 记录运行时提示词版本/hash、精确任务 hash、创建选择与请求头路由；旧记录可缺省、非法追溯拒绝保存、摘要深拷贝。取消/中途崩溃可能只有初始追溯，空路由不证明没有请求。
- 直接依赖结果按不可信 JSON 追加；缺失/截断及追加后 prompt >64KiB 拒绝，其他工具不插值。
- 只读 Worker 并行，但与本 run 的 edit/write/pwsh 批次隔离；不提供跨 run 或外部写锁。
- whenIdle 后的 turn/end 与最终文本检查，子会话 ID checkpoint/摘要投影，同步 run/服务 dispose 等待取消/超时的 Worker dispose，runtime_cancel 仅发起、不证明已清理；未知 Agent 恢复失败全 run、不自动重试或重放。

组件 mock/宿主夹具即使通过，也不能替代真实模型、桌面 UI 或实际 OS 沙箱验收；这些仍为 **pending**。Agent 的 `succeeded` 与输出文本不构成内容验收，须由 Lead 核实。

## 自动化检查范围

| 层次 | 检查内容 | 证据边界 |
|---|---|---|
| 计划 schema | DAG、依赖、环、工具白名单、retry 限制、大小/超时/并发上限、未知字段 | 非法计划在进入执行前被拒绝 |
| 执行器 | 批次 DAG、依赖顺序、只读失败重试、超时不重试、每步 checkpoint、取消与晚到结果、未知副作用恢复停止新步骤 | 组件级状态机与注入故障，不代表底层工具必定响应取消 |
| 持久化 | 原子写及失败清理、4MiB 记录上限、完整校验及坏记录诊断、owner 过滤分页、终态保留、启动 `running→interrupted` | 文件状态与故障回归，不是分布式锁 |
| 运行服务 | 同 root 共享 active、跨 owner 隔离、run/resume 的 8 active 准入、同步信号/async detach、关闭与保留 | 单进程内服务组合；工具调用可用桩替代 |
| 真实宿主组件 | Cordis ToolRuntime + 公开 `ToolExecutionPipeline.prepare/dispatch/complete` 链路、嵌套 write deny | rc.1 迁移结果待复核；Agent 与 read/write/pwsh 实现可为夹具，deny 不是实际 sandbox |
| 真实进程故障 | fork 子进程执行、实际 kill、启动新进程 resume；成功写不重放、在途未知写阻止后续步骤 | 真实进程生命周期，子进程内工具仍为测试实现，不等于完整宿主桌面重启 |
| 真实 pwsh 工具 | 宿主 pwsh 工具 + 实际 pwsh 进程：零/非零退出、自动转后台保留 jobId 并收集停止 | shell bridge 不是实际 sandbox；无 pwsh 环境会跳过，须看本次输出 |
| 预设与模式 | 派生预设注册、默认预设不变、普通 Agent 不可见运行时、启动失败与声明边界、宿主策略拒绝仍有效 | 隔离与权限边界成立；不是实际桌面预设切换验收 |
| PTC 整链 | 独立 native/PTC 执行器组件、Node PTC 子进程、生成 SDK、run_code → runtime_run → 嵌套宿主工具 | rc.1 迁移结果待复核；组件与进程不是实际模型、桌面或 sandbox provider 验收 |
| 运行展示与离线工具 | 进度与unknown提示、候选验收账本、pilot观测白名单及容量基准 | 只证明投影/校验与组件行为；人工断言、实际UI和模型收益需单独验收 |
| 发布门禁 | 全量测试、包白名单、四矩阵 CI、npm 后逐字节校验 | 各自执行后才提供对应证据；本地测试不代替发布验收 |

以上是当前测试的目标覆盖范围，不是本轮通过声明。新增或变更的回归须执行复核；通过、失败、跳过及最终覆盖以本次 `npm run check` 实际输出为准，不固定测试数量，也不沿用旧轮次结果。

## 未验证或明确不支持

| 项目 | 结论 |
|---|---|
| 真实模型/桌面 UI/实际沙箱 | 未验收；组件测试与桩不等于桌面/模型验收 |
| 完整宿主崩溃 + 桌面重启恢复 | 真实 fork/kill 测试只覆盖运行时进程夹具，不代表完整宿主/桌面端到端验收 |
| exactly-once 副作用 | 不支持；崩溃时在途副作用可能已发生，只能标记 unknown/failed |
| 跨进程/分布式执行 | 不支持；运行时随宿主进程退出 |
| 大结果/长计划 | 单步结果 >64KiB 截断；计划 ≤64KiB、32 步 |
| 宿主版本漂移 | 工作树目标为 DSH 0.2.2-rc.1 的公开 pipeline/preset 契约；不推导兼容其他 rc 或未来版本，升级需复核 |

真实模型、桌面 UI、实际 OS 沙箱、整宿主生命周期与收益 pilot 尚未真实验收，状态保持 `pending`。生产依赖临时安装 smoke 只验证入口、注册和离线工具导入（stub host），不等于桌面安装或模型执行。宿主上游依赖安全告警是独立风险，不能用功能测试通过抵销，见[宿主兼容性](<host-compatibility.md#依赖安全告警>)。

## 使用约束

1. 每步调用前、完成/重试时 checkpoint；落盘失败停止后续调度。进程退出后仅保留已落盘状态。恢复未知副作用或未知 Agent 使整个 run `failed`，不再调新步骤；只读超时不 retry，避免与原调用重叠。
2. 计划质量由模型决定；稳定流程适合，探索型任务用原工具。
3. 取消及时停止调度并传播信号，Agent 取消/超时由同步 run/服务 dispose 等待 Worker dispose，runtime_cancel 仅发起取消、返回不证明清理完成，但普通工具可能不合作；`unknown` 不等于已停止或 rollback。同步 run/resume 绑定外层 signal；仅不含 Agent 的计划可用 `async:true`，受理后脱离外层信号。
4. 同 root 单进程共享 8 active，run/resume 都需准入。status 列表仅本会话，`limit` 1–100（默认 20）、`offset` 0–10000（默认 0）。默认仅保留最新 100 条终态，保护 `running/interrupted`；恢复可能有老记录。
5. 显式 `pwsh run_in_background:true` 预检拒绝；auto-promote 后 run 失败、步骤 `unknown`，保留 `jobId`，需用原生 `job_output/job_kill` 收集或停止，不表示命令已完成。
