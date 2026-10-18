# 宿主兼容性

目标宿主：DSH **0.2.1-rc.2**、Cordis 4.0.4、Node ≥22。

## 依赖的宿主契约

- 工具注册与执行：`ctx.tools.register` / `ctx.tools.execute`；运行时用父工具调用的 `exec.token` 作为 `parent`，沿用宿主权限、工作目录与沙箱。
- 预设派生：通过 `agentPresets.readDocument("ptc")` 读取公开声明，再用 `register` 注册派生预设；不修改默认预设或全局工具。
- 模式提示：`ctx.systemPrompt.section` 追加运行时说明。

## 已知边界

- 运行时在宿主进程内执行；不依赖私有 PTC 中断字符串，也不保证跨宿主版本。
- 计划步骤使用宿主工具自身 schema；宿主升级导致工具参数变化时需同步计划示例。
- 运行记录为本地文件，不参与宿主会话日志恢复。

升级宿主后至少重跑 `npm run check` 与真实 ToolRuntime 集成测试。
