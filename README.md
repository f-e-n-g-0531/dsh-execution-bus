# 萧何 / Xiao He

**声明式运行时：模型提交计划，程序负责执行、重试、落盘与恢复。**

仓库 dsh-execution-bus、npm 包名、预设 ID `xiao-he-runtime` 保持不变；历史 0.x 版本说明保留当时名称。

DSH 独立插件：`@feng0531/dsh-execution-bus` · 当前版本 **1.1.1**

> 1.0 起产品从“执行总线模式”切换为**声明式运行时**：`runtime_run` 接收 DAG 计划，运行时按依赖并行执行、对只读步骤重试、逐步落盘并支持重启后恢复。旧的 `execution_bus` 工具与 `./core` 导出已移除；0.12.1 是最后一个总线版本，仍可在 npm/git 历史中查看。

## 它解决什么问题？

模型提交**步骤和执行依赖**，不再需要在 `run_code` 里写循环、反复等待；运行时负责调度，但不保证副作用只发生一次：

| 问题 | 运行时处理 |
|---|---|
| 多个独立工具操作串行、慢 | 无依赖步骤并行执行（并发 1–4） |
| 步骤需要等待前置完成 | `depends_on` 建 DAG，仅约束执行顺序，不注入前置结果 |
| 只读步骤偶发失败 | 仅 `read/glob/grep` 可配置失败重试 `retry`（0–3）；超时不重试，避免重叠调用 |
| 单步卡死 | 每步 `timeout_ms`（1s–600s） |
| 长任务跨步骤 | 默认同步等待；`async:true` 返回 `runId`，用 `runtime_status/runtime_result` 取回 |
| 进程重启/崩溃 | 运行记录落盘，重启后标记 `interrupted`，`runtime_resume` 恢复只读步骤 |
| 需要停止 | `runtime_cancel` 停止调度并传播取消 |

## 安装与启用

```text
npm install --ignore-scripts @feng0531/dsh-execution-bus@1.1.1
```

将包加入目标 DSH 配置的 `dsh.profile.bundles`（或使用宿主插件管理器的 bundle 加载），加载后会出现独立预设 **xiao-he-runtime**。普通任务仍用原工具；预设不接管终端、编辑或全局工具，授权与沙箱由宿主管理。发布不会自动安装或重启你的 DSH。

## 工具

| 工具 | 作用 |
|---|---|
| `runtime_run` | 提交计划；默认等待完成返回步骤状态，`async:true` 立即返回 `runId` |
| `runtime_status` | 无 `runId` 按本会话分页（`limit` 1–100，默认 20；`offset` 0–10000，默认 0）；带 `runId` 返回步骤状态（不含结果） |
| `runtime_result` | 读取已保存的步骤结果（单步 >64KiB 只返回 `truncated/bytes`） |
| `runtime_cancel` | 停止调度、传播取消 |
| `runtime_resume` | 显式恢复 `interrupted` 运行 |

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

允许工具：`read/glob/grep/edit/write/pwsh`；`retry` 只允许 `read/glob/grep`。计划上限：32 步、64KiB、并发 1–4、超时 1s–600s。

## 语义与限制

- 同一记录 root 在单进程内共享最多 **8 个 active run**；`runtime_run` 与 `runtime_resume` 都受准入限制，不是跨进程锁。
- 每步 checkpoint；记录在 `DSH_HOME/tmp/xiaohe-runtime/runs`（`XIAOHE_RUNTIME_DIR` 可覆盖），按会话隔离。默认保留最新 100 条终态，保护 `running/interrupted`。
- 取消停止调度，不保证工具实际停止或 rollback；**不保证 exactly-once**。恢复遇到未知副作用使整个 run `failed`，不再调新步骤。
- 同步 run/resume 绑定外层 signal；`async:true` 成功接收后脱离外层信号。`pwsh` 显式后台预检拒绝，自动转后台不算命令完成，保留 `jobId` 供原生 `job_output/job_kill` 收集。详见[协议与恢复边界](<docs/protocol.md>)。
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

- [声明式运行时设计](<docs/DECLARATIVE-RUNTIME.md>)、[协议](<docs/protocol.md>)、[验证范围](<docs/validation.md>)、[产品结构](<docs/PRODUCT.md>)
- [1.1.1 发布说明](<docs/releases/1.1.1.md>)、[发布流程](<docs/RELEASING.md>)、[第三方说明](<THIRD_PARTY_NOTICES.md>)
- 0.x 总线历史与复盘：[复盘](<docs/RETROSPECTIVE.md>)、[整合说明](<docs/INTEGRATION.md>)
