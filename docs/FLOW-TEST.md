# 流程测试说明

1. 安装候选包并在隔离 DSH 配置中加载 bundle，确认预设 **xiao-he-runtime** 出现且默认预设未变。
2. 在会话中调用 `runtime_run` 提交一个两步计划（read + echo），确认返回 `succeeded` 与步骤状态。
3. 提交 `async:true` 计划，用 `runtime_status`/`runtime_result` 取回；成功接收后外层 signal 不应取消它。同步 run/resume 应绑定外层 signal；`runtime_cancel` 应及时停止调度，但不能据此断言不合作工具已退出或副作用已回滚。
4. 中断宿主后重启并检查 `runtime_status`：遗留运行应为 `interrupted`。检查每步 checkpoint 已保存成功步骤；resume 可重排在途只读步骤，但未知副作用必须使整个 run 失败且不调新步骤。
5. 验证普通 Agent 看不到 `runtime_*` 工具，宿主写策略拒绝仍生效。
6. 核对同 root 单进程共享 8 个 active run、run/resume 准入和 status 分页（`limit` 1–100、`offset` 0–10000）；默认仅清理超过最新 100 条的终态，保护 `running/interrupted`。
7. `pwsh` 显式 `run_in_background:true` 应在预检拒绝；自动转后台不能放行下游，须从 `runtime_result` 取 `jobId` 并用原生 `job_output/job_kill` 收集或停止。

边界：以上是验收步骤，不是已通过记录。自动化测试范围见[验证范围](<validation.md>)，通过与跳过状态以本次 `npm run check` 实际输出为准。真实 fork kill + 重启、真实 ToolRuntime 嵌套 deny、真实 pwsh 工具与实际 pwsh 进程属于不同证据层次；pwsh 测试的 shell bridge 不是实际 sandbox。真实模型、桌面 UI 与实际沙箱仍未验收。

## 本地会话指标

`npm run metrics:sessions -- --sessions <日志目录> --preset xiao-he-runtime --json` 仅读取本地会话日志，不发送网络遥测。输出包含 runtime 工具请求、观测运行状态与步骤 attempts；同一会话内按运行/步骤去重。取消和恢复仅计请求，缺失结果不推测成功；跨会话重复出现的运行分别计数。默认不输出业务输入、命令、路径或结果正文，但哈希标识不等于匿名。需要支持 zstd 的 Node 构建（22.15+ 或 23.8+）；坏日志和不支持的事件会报告诊断，不静默当作零使用。

## 小范围收益对照试验（待真实 pilot）

- 固定任务、输入快照、成功判据、宿主与模型版本、权限及资源预算；两组使用相同环境与重复次数，保留失败和人工中止样本。
- 对照组使用原生工具与原生并行能力，而不只是串行调用；实验组使用运行时 DAG。记录计划准备与恢复成本，避免把不同并发额度当成运行时收益。
- 分别记录任务成功率、模型调用次数、人工介入次数和端到端耗时；按同一口径比较，不只报告成功样本或单次最快耗时。
- 在相同故障点中断并恢复，核对实际副作用计数、已保存步骤重放数、未知副作用及停止后的新增步骤数；`unknown` 不能计作未发生副作用。
- 未完成真实 pilot 前不写收益数字，不从自动化契约测试推导模型效率、成本或生产可靠性结论。
