# 验证范围与使用限制

本文说明证据边界，不是生产环境认证。当前公开基线为 **v1.3.2**（提交 `8d1a5bf`），已于 2026-11-04 发布至 [npm](https://registry.npmjs.org/@feng0531/dsh-execution-bus/1.3.2) 和 [GitHub Release](https://github.com/f-e-n-g-0531/dsh-execution-bus/releases/tag/v1.3.2)，交付范围见[发布说明](<releases/1.3.2.md>)；v1.3.0 是历史研发起点，v1.3.2 生产运行时与 v1.3.1 一致；版本发布不代表下述真实环境验收已经完成。v1.3.4依赖目标为 **DSH 0.2.2-rc.1**、Cordis ~4.1.0、include ~1.1.0、Node ≥22；包版本为 1.3.4，公开 1.3.3 的原包兼容范围不因本次适配而改变，兼容范围见[宿主兼容性](<host-compatibility.md>)。历史 v1.2.0 的 Windows、Node.js 24.21.0、DSH rc.2 组件验证记录只属于当时版本，不能代替 rc.1 工作树候选的复核。后续研发与真实验收门禁见[研发计划](<DEVELOPMENT-PLAN.md>)。

公开版本验证只属于其原始候选；工作树或包内容变化后须重新绑定候选 SHA，不沿用公开包验证结论。环境与预算按[研发准备记录](<RESEARCH-READINESS.md>)确认，模板完整不代表已验收。

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

1. 每步调用前、完成/重试时 checkpoint；落盘失败停止后续调度。进程退出后仅保留已落盘状态。恢复未知副作用使整个 run `failed`，不再调新步骤；只读超时不 retry，避免与原调用重叠。
2. 计划质量由模型决定；稳定流程适合，探索型任务用原工具。
3. 取消及时停止调度并传播信号，但工具可能不合作；`unknown` 不等于已停止或 rollback。同步 run/resume 绑定外层 signal；`async:true` 成功接收后脱离外层信号。
4. 同 root 单进程共享 8 active，run/resume 都需准入。status 列表仅本会话，`limit` 1–100（默认 20）、`offset` 0–10000（默认 0）。默认仅保留最新 100 条终态，保护 `running/interrupted`；恢复可能有老记录。
5. 显式 `pwsh run_in_background:true` 预检拒绝；auto-promote 后 run 失败、步骤 `unknown`，保留 `jobId`，需用原生 `job_output/job_kill` 收集或停止，不表示命令已完成。
