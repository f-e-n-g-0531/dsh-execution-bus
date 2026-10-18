# 流程测试说明

1. 安装候选包并在隔离 DSH 配置中加载 bundle，确认预设 **xiao-he-runtime** 出现且默认预设未变。
2. 在会话中调用 `runtime_run` 提交一个两步计划（read + echo），确认返回 `succeeded` 与步骤状态。
3. 提交 `async:true` 计划，用 `runtime_status`/`runtime_result` 取回；用 `runtime_cancel` 验证取消。
4. 重启宿主后检查 `runtime_status`：未完成运行应为 `interrupted`，用 `runtime_resume` 恢复只读步骤。
5. 验证普通 Agent 看不到 `runtime_*` 工具，宿主写策略拒绝仍生效。

边界：测试夹具使用测试 Agent 与工具桩，不代表真实模型、桌面 UI 或实际沙箱验收。
