# 产品结构与维护契约

## 产品边界

萧何是 DSH 内的可选**PTC 多 Agent 编排与声明式运行时**插件：Lead 用 PTC 提交 DAG，运行时执行 `read/glob/grep/edit/write/pwsh` 或 `agent` 步骤，负责并行、只读工具重试、超时、落盘、取消与恢复；Lead 负责修改与验收。当前 mode 原地改造，仍从 PTC 派生并沿用 `xiao-he-runtime`，不新增 team 模式。多 Agent 能力随 1.4.0 发布。它不是模型、不是通用工作流引擎、不接管全部工具；权限、沙箱与审批仍由宿主管理。

1.0 移除了 0.x 的执行总线（`execution_bus`、`./core` 导出与总线预设），旧版本保留在 npm/git 历史，不再维护。

> **当前安全兼容边界：**DSH V0.2 已核实版本没有“仅补查父级缺失策略且去重公共层”的公开接口。本插件入口未接入可信 `DelegationPolicyAdapter`，含 `agent` 的 run/resume 在执行前以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 拒绝；普通工具 DAG 不受影响。下述 Worker 执行能力仅适用于显式注入该适配器的受控宿主集成，测试适配器不是已验证 V0.2 版本的通用实现。不能通过删父策略、回放完整父链或修改已安装宿主绕过此门禁。

## 入口与配置

| 入口 | 谁使用 | 责任 |
|---|---|---|
| 包级 bundle /preset | DSH 配置加载器 | 读取 ptc 声明快照，注册独立预设 `xiao-he-runtime` |
| Agent 内 /mode | 预设末尾插件行 | 追加运行时工具与模式说明 |
| `./test-mode` | 兼容别名 | 与 /mode 同一模块 |

普通任务继续用原工具；运行时只处理“能写成稳定 DAG”的协调工作，简单一次性操作不包装。普通工具的 `depends_on` 只约束顺序，不插值结果；Agent 则追加直接依赖结果为不可信 JSON（缺失/截断或追加 prompt >64KiB 拒绝）；同一记录 root 的单进程 service 共享 8 个 active run，run/resume 均需准入。

Worker 通过公开 `agents.create` + `agentPresets.composeFrom` 创建独立上下文并继承模型路由，强制使用 `NativeToolExecutor`（不是 PTC），宿主沙箱 read-only、approval never，guard 仅允许 `read/glob/grep` 并与父 admission identity 取交集。禁止 `run_code`、命令、写入与递归委派；不靠提示词限制权限。Agent 输入为 `{prompt, access?:"read", max_steps?:1..32, output_format?:"text"|"report"}`（默认 12 步；省略输出格式保留旧 text），不支持 write 或写入范围授权；非空 `write_scopes` 拒绝，空数组仅作兼容归一化。

只读 Worker 可并行，但不与本 run 的直接写入/命令步骤同批，不锁跨 run 或外部写入。含 Agent 的计划不支持 `async:true` 或 service `background=true`，在创建 run/Worker 前以 `RUNTIME_AGENT_ASYNC_UNSUPPORTED` 拒绝：父 `exec.toolSet` 随外层工具批次返回而 dispose，不能安全 detach Worker；普通工具计划若携带 `exec.toolSet`，异步或 service 后台提交也在创建 run 前以 `RUNTIME_ASYNC_ADMISSION_UNSUPPORTED` 拒绝；宿主批次结束会销毁该准入集合，没有公开续租接口。不得删除准入集合或重新解析以绕过限制；请使用同步调用。Agent 不 retry、不自动重放；同步 run/服务 dispose 等待取消/超时的 Worker dispose，`runtime_cancel` 仅发起取消，返回不证明清理完成；恢复未知 Agent 失败整个 run。子会话 ID 在 checkpoint 与摘要可见，`succeeded` 不是验收结论。详见[协议](<protocol.md#agent-步骤受控宿主集成>)。

结构化 `report` 包含 `outcome/summary/evidence/limitations` 与可选 `requestedDecision`，严格校验纯 JSON、字段白名单、大小与状态约束，保留原始 `output` 和 `verification:"not_independently_verified"`。所有模式均由步骤记录及摘要的可选 `workerTrace` 暴露追溯，`results[step].value` 仅含 `sessionId/output/verification` 与 report 模式的 `report`；trace 不进入结果 value 或依赖 JSON，不占用原有单步结果 64KiB 配额。追溯语义为：运行时角色/输出契约的 `promptVersion/promptHash` 不覆盖整个宿主 prompt；`taskPromptHash` 覆盖追加依赖后的精确任务 prompt；`selectedModel` 是创建时选择，`requestModels` 仅为 `request/header` 连续去重路由，不是请求次数或网络成功凭证。追溯仅在任务启动前和 `whenIdle` 后 checkpoint，取消/中途崩溃可能只有初始空 `requestModels`。详见[报告与追溯契约](<protocol.md#结构化报告与追溯>)。

报告证据是 Worker 自报，不提供授权或独立验收；报告 outcome 不改变 DAG success 条件：正常结束且格式合格的 `partial/blocked` 也可放行下游。依赖只表示顺序，不能把报告解释为自动写入授权；Lead 验收后另行修改。

## 非目标

- 不做跨进程/分布式执行，不保证 exactly-once 或副作用回滚。取消及时停止调度，但工具可能不合作；`unknown` 不代表副作用未发生。恢复遇到未知副作用时整个 run 失败，不再调新步骤。
- 不替代宿主后台 Job、Teams、Skills、Goals；当前 Agent 步骤是受限的只读 DAG 分工，不是新的通用 team 模式或可写 Worker 系统。
- 真实模型、桌面 UI 与实际沙箱仍未验收；测试证据必须区分组件桩、真实 ToolRuntime、真实进程与实际沙箱，见[验证范围](<validation.md>)。

## 维护契约

- 工具名与公开导出变更必须升主版本；工具 schema 变更需同步文档与测试。
- 运行记录格式带 `version:1`；破坏兼容需迁移或拒绝旧记录。每步 checkpoint；默认只保留最新 100 条终态，保护 `running/interrupted`，不能假设恢复记录都是近期记录。
- 发布门禁：全量测试、包白名单、标签 CI 四矩阵、npm 后公开校验、GitHub Release。
- 宿主插件列表显示名通过 `locale/en.json`/`locale/zh.json` 的 `meta.title` 提供，统一为 `PRODUCT.name`（萧何 / Xiao He）；中文资源文件名使用宿主活动语言 ID `zh`。npm 包名、预设 ID、工具名、运行记录格式不随显示名变化。
