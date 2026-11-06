# 宿主兼容性

v1.4.0 目标宿主：DSH **0.2.2-rc.1**、Cordis ~4.1.0、include ~1.1.0、Node ≥22；锁定依赖实际解析为 Cordis 4.1.0、include 1.1.0。DSH peer 与测试依赖精确锁定 0.2.2-rc.1，不推导兼容其他版本。旧公开 1.3.3 的宿主目标仍为 0.2.1-rc.5，不追认新宿主支持。

> **当前安全兼容边界：**标准 DSH 0.2.2-rc.1 没有“仅补查父级缺失策略且去重公共层”的公开接口。本插件入口未接入可信 `DelegationPolicyAdapter`，含 `agent` 的 run/resume 在执行前以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 拒绝；普通工具 DAG 不受影响。下述 Worker 执行能力仅适用于显式注入该适配器的受控宿主集成，测试适配器不是 rc.1 通用实现。不能通过删父策略、回放完整父链或修改已安装宿主绕过此门禁。

## 可信适配核实（2026-11-06）

本轮重新检查当前安装的 rc.1 SDK：ToolsService 的 executable 只检查 admission/可执行身份，checkGuards 执行 global 与作用域全链；ToolExecutionPipeline.prepare 执行完整 pre-execute、审批及 guard，没有 supplemental-only 或公共层去重参数。parentAgent 表示生命周期归属，不等于继承父局部工具策略。因此不提供无条件 allow 适配器，不修改宿主，不通过回放父完整 pipeline 重复检查或弹出审批。标准入口继续支持普通工具 DAG、拒绝 Worker；这是尚未打通的核心限制，不宣称多 Agent 已可日常使用。未来需宿主提供可信的缺失父策略检查能力后再接入并验收。

## 依赖的宿主契约

- 工具注册仍使用 `ctx.tools.register`；rc.1 的 `ctx.tools.execute` 已为 batch 接口，不能沿用旧单调用形式。运行时通过公开 `ToolExecutionPipeline.prepare/dispatch/complete` 执行嵌套工具，传递 `parent: exec.token`、`rootCallId`、`agent`、`signal` 与 `toolSet`，沿用宿主权限、工作目录与沙箱，不绕过宿主策略。
- 预设派生：通过 `agentPresets.readDocument("ptc")` 读取公开声明，再用 `register` 注册派生预设；不修改默认预设或全局工具。
- 模式提示：`ctx.systemPrompt.section` 追加运行时说明。
- 同步 run/resume 传播外层 signal；仅不含 Agent 且调用未携带 `exec.toolSet` 的受控宿主计划可用 `async:true`，成功接收后脱离外层信号，但仍在宿主进程内。取消不保证不合作工具退出。
- `pwsh` 前台返回须检查退出码、中止/超时与沙箱失败；显式 `run_in_background:true` 被运行时预检拒绝。自动转后台只表示已生成 Job，运行时标为失败/`unknown` 并保留 `jobId`，用宿主原生 `job_output/job_kill` 收集或停止。

## rc.1 迁移与历史证据边界

- 历史 rc.2 与 rc.5 的 tools、scope、preset-registry、agent-tool-presentation、system-prompt 共8份公开类型声明一致，仅属于当时版本；不能用于证明 rc.1 接口相同或免除迁移。
- 本轮 ToolRuntime、文件 DAG、命令回执、展示、预设隔离与 Node PTC 子进程组件测试迁移至 rc.1；native/PTC 使用独立 `@deepseek-ai/dsh-tool-executor-native` / `@deepseek-ai/dsh-tool-executor-ptc` 组件，不以旧执行器夹具代替。适配阶段组件回归已完成，最终候选与标签 CI 结果以对应流水线为准；生产候选安装还须检查当前 `package.json` 声明的全部 DSH peer（agent-preset-registry、agent、llm、session、sandbox-policy、user-approval、working-directory、tool-executor-native、scope、system-prompt、tools，包名前缀均为 `@deepseek-ai/dsh-`）实际解析均为 0.2.2-rc.1，不再只检查原四项。
- PTC 组件夹具使用 danger-full-access，不覆盖 rc.1 的只读/工作区 OS 沙箱 confine 路径；per-call 模式不代表已验证 persistent 模式。组件迁移不构成真实模型调用、桌面安装或整宿主重启验收。

## 依赖安全告警

2026-11-05 的 npm audit 对当前完整锁定依赖树返回 **36 个受影响包节点（33 high、3 moderate、0 critical）**，告警根包实际解析为 undici 8.11.2、zod 4.4.3；传播节点数不是36个独立漏洞，也不是生产安装树或生产可达性评估。项目未打包第三方依赖，但生产安装会通过宿主 peer 解析相关依赖。宿主升级和功能兼容不表示告警已修复；本轮不使用 force、legacy-peer-deps 或 overrides 绕过精确依赖要求。涉及不可信网络/输入的部署需结合上游修复及实际依赖路径独立评估，重新审计以当时数据库为准。

## 已知边界

- 运行时在宿主进程内执行；不依赖私有 PTC 中断字符串，也不保证跨宿主版本。
- 计划步骤使用宿主工具自身 schema；宿主升级导致工具参数变化时需同步计划示例。
- 运行记录为本地文件，不参与宿主会话日志恢复。

升级宿主后至少重跑 `npm run check` 与真实 ToolRuntime 集成测试；记录实际通过/失败/跳过，不能用测试文件存在代替执行证据。真实 pwsh 工具 + 实际 pwsh 进程测试使用 shell bridge，不等于实际 sandbox 验收；桌面 UI、模型与实际沙箱仍未验收。
