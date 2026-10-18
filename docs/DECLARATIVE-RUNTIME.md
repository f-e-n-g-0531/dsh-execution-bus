# 声明式运行时（1.0 迁移中）

> 状态：**第一阶段已落地**（运行时内核 + 工具 + 落盘恢复 + 测试），旧 `execution_bus` 暂保留为兼容；后续版本移除旧总线并统一文档。

## 它是什么

模型不再在 `run_code` 里写循环/等待，而是提交一份**计划（plan）**：

```json
{
  "goal": "读取两个文件并汇总",
  "concurrency": 2,
  "steps": [
    { "id": "a", "tool": "read", "input": { "file_path": "README.md" } },
    { "id": "b", "tool": "read", "input": { "file_path": "package.json" } },
    { "id": "c", "tool": "pwsh", "input": { "description": "汇总", "command": "echo ok" }, "depends_on": ["a", "b"] }
  ]
}
```

运行时负责：DAG 校验、独立步骤并行、只读步骤重试、每步超时、结果落盘、取消与重启后恢复。模型只表达意图和依赖，不写编排代码。

## 工具

| 工具 | 作用 |
|---|---|
| `runtime_run` | 提交计划；默认等待完成并返回步骤状态，`async:true` 立即返回 `runId` |
| `runtime_status` | 无 runId 列出最近运行；带 runId 返回步骤状态（不含结果） |
| `runtime_result` | 读取已保存的步骤结果（单步 >64KiB 只返回 truncated/bytes） |
| `runtime_cancel` | 停止调度、传播取消 |
| `runtime_resume` | 显式恢复 `interrupted` 运行（只读步骤重排，副作用在途步骤标 failed） |

## 语义与边界

- 允许工具：`read/glob/grep/edit/write/pwsh`；`retry` 只允许 `read/glob/grep`。
- 计划上限：32 步、64KiB、并发 1–4、单步超时 1s–600s。
- 运行记录保存在 `DSH_HOME/tmp/xiaohe-runtime/runs`（可用 `XIAOHE_RUNTIME_DIR` 覆盖），按会话隔离。
- 崩溃/重启后运行标记 `interrupted`；在途步骤 `unknown`。**不保证 exactly-once**：副作用可能已发生，恢复时副作用步骤标 `failed/RUNTIME_INTERRUPTED`，只读步骤可重排。
- 不做跨进程执行、不做分布式队列；运行时随宿主进程退出。
- 计划质量是新的失败来源；稳定、可枚举的流程适合，探索型任务仍用 PTC 原工具。

## 与旧 execution_bus 的关系

旧总线（`execution_bus` 工具）提供 requestId 去重、预算分离等待与宿主 Job 投影；声明式运行时提供更上层的计划编排与恢复。两者当前共存，文档与预设会在后续版本收敛到运行时，旧总线冻结为历史参考。
