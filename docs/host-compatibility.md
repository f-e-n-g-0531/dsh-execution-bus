# 宿主兼容性

目标宿主：DSH **0.2.1-rc.2**、Cordis ~4.0.4、Node ≥22；当前锁定依赖实际解析为 Cordis 4.0.5。

## 依赖的宿主契约

- 工具注册与执行：`ctx.tools.register` / `ctx.tools.execute`；运行时用父工具调用的 `exec.token` 作为 `parent`，沿用宿主权限、工作目录与沙箱。
- 预设派生：通过 `agentPresets.readDocument("ptc")` 读取公开声明，再用 `register` 注册派生预设；不修改默认预设或全局工具。
- 模式提示：`ctx.systemPrompt.section` 追加运行时说明。
- 同步 run/resume 传播外层 signal；`async:true` 成功接收后脱离外层信号，但仍在宿主进程内。取消不保证不合作工具退出。
- `pwsh` 前台返回须检查退出码、中止/超时与沙箱失败；显式 `run_in_background:true` 被运行时预检拒绝。自动转后台只表示已生成 Job，运行时标为失败/`unknown` 并保留 `jobId`，用宿主原生 `job_output/job_kill` 收集或停止。

## 已知边界

- 运行时在宿主进程内执行；不依赖私有 PTC 中断字符串，也不保证跨宿主版本。
- 计划步骤使用宿主工具自身 schema；宿主升级导致工具参数变化时需同步计划示例。
- 运行记录为本地文件，不参与宿主会话日志恢复。

升级宿主后至少重跑 `npm run check` 与真实 ToolRuntime 集成测试；记录实际通过/失败/跳过，不能用测试文件存在代替执行证据。真实 pwsh 工具 + 实际 pwsh 进程测试使用 shell bridge，不等于实际 sandbox 验收；桌面 UI、模型与实际沙箱仍未验收。
