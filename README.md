# 萧何 / Xiao He

**给 DeepSeek Harness（DSH）的多步骤工具任务加上依赖调度、运行记录和可核查的恢复流程。**

模型说明“做哪些步骤、先后有什么依赖”，萧何负责执行与保存结果；主助手（Lead）负责判断结果、继续修改和验收。适合把已经明确的重复操作交给运行时，而不是让模型每次重新编写调度代码。

DSH 插件：`@feng0531/dsh-execution-bus` · [查看 npm 公开版本](https://www.npmjs.com/package/@feng0531/dsh-execution-bus) · 当前版本 **1.8.5** · [版本说明](<docs/releases/1.8.5.md>)

> **标准插件可运行普通工具计划**，也不影响 DSH 原生委派；但标准入口不会执行含 `agent` 步骤的计划。

## 为什么使用萧何？

- **少写调度代码**：用计划声明步骤和依赖，独立步骤可并行，前置成功后再执行后续步骤。
- **结果可追溯**：每步保存检查点，按运行或任务查看状态、结果与下一步待办。
- **只读失败可控重试**：仅 `read/glob/grep` 支持有限重试；确定性错误和超时不会盲目重试。
- **中断后不冒险重放**：显式恢复可重排在途只读步骤；遇到未知写入、命令或 Agent 状态停止恢复，先核实实际影响。
- **执行与验收分开**：运行成功不等于任务完成；已知悉、决策处置和结果复核各有记录，不互相冒充。

它不是分布式工作流服务、后台常驻代理或自动开发平台，也不替代 DSH 的授权与沙箱。

## 适合谁？

适合已经确定工具参数和依赖、又需要保存步骤结果的任务，例如：

- 批量核查文件，保存每步结果供主助手复核；
- 按固定顺序执行检查、收集诊断材料，并保留每步结果；
- 跟踪同一任务的多次运行，查找待处理问题和待复核结果。

一次简单读写、单条命令、仍需边读边决定下一步的探索，直接用原生工具更省事。

## 安装与启用

### 1. 确认环境

- 本版重点适配 DSH **0.2.3-alpha.2**；该宿主要求 Node.js **24.22.3+（24.x）或 26.13.1+**，以宿主安装要求为准。兼容范围仅包含已验证的 DSH V0.2 版本，不推导对未验证版本或未来版本的兼容。
- 宿主已有声明式 ptc 预设。萧何从它派生独立预设，不覆盖原 PTC 或全局工具。
- 宿主依赖目标与已知告警见[宿主兼容性](<docs/host-compatibility.md>)。

### 2. 安装插件

安装 npm 上的公开版本：

```text
npm install --ignore-scripts @feng0531/dsh-execution-bus
```

将包加入该配置的 `dsh.profile.bundles`，或通过宿主插件管理器加载 bundle。加载后选择 **萧何 / Xiao He**，预设 ID 为 `xiao-he-runtime`。安装 npm 包本身不等于已加载 bundle；发布新版本也不会自动升级或重启你的 DSH。

试用未发布的工作树版本时，按[维护者流程](<docs/RELEASING.md#2-本地验证>)生成候选包，并只在[独立配置](<docs/FLOW-TEST.md#隔离真实验收的前置条件>)中加载。

## 第一次使用

可以向主助手这样描述任务：

> 用萧何并行读取 README.md 和 package.json，保存每步结果，再由你总结项目用途与运行要求。先查询能力，只使用普通工具，不创建 Worker。

运行顺序：

```text
明确任务 → 查询能力 → 提交步骤计划 → 按依赖执行并保存结果 → 主助手读取与核实 → 交付结果
```

### 什么时候选择普通工具 DAG

当任务需要逐步保存结果、只读失败重试或中断后核对时，提交同步 `runtime_run`，完成后用 `runtime_result` 核实。遇到锁冲突或存储失败，先按[故障处置](<docs/OPERATIONS.md#常见故障>)检查，不自动重发未知副作用。

需要演练中断后如何核对与恢复，可在隔离环境按[普通工具 DAG 中断恢复示例](<docs/FLOW-TEST.md#普通工具-dag-中断恢复示例>)操作。

### 一个可读的计划

下面是在本仓库读取两个文件的计划。其他项目应换成实际存在、且宿主允许访问的路径：

```json
{
  "goal": "并行读取项目介绍和包配置",
  "concurrency": 2,
  "steps": [
    { "id": "intro", "tool": "read", "input": { "file_path": "README.md" }, "retry": 1 },
    { "id": "package", "tool": "read", "input": { "file_path": "package.json" }, "retry": 1 }
  ]
}
```

由主助手调用 `runtime_run`，输入为 `{plan: 上面的计划}`。默认同步等待，返回运行 ID 和步骤状态；用 `runtime_result({runId})` 读取保存的结果。`runtime_capabilities({})` 可查询支持的能力，但不能代替权限或存储检查。

后续步骤可用 `depends_on:["intro","package"]` 声明执行依赖。**普通工具的依赖只控制顺序，不自动传递或插值前置结果**；需要根据文件内容决定下一步时，应由主助手读完结果后再组织计划。

### 常用入口

| 想做什么 | 工具 |
|---|---|
| 确认可用能力 | `runtime_capabilities` |
| 提交计划、查看状态、读取结果 | `runtime_run`、`runtime_status`、`runtime_result` |
| 查看同任务运行、跨任务待办或待复核结果 | `runtime_task`、`runtime_query` |
| 发起取消、显式恢复中断运行 | `runtime_cancel`、`runtime_resume` |
| 记录已知悉、决策处置、结果复核 | `runtime_acknowledge`、`runtime_decision`、`runtime_review` |
| 创建显式交接摘要、管理通知回执 | `runtime_handoff`、`runtime_notification` |

例如 `runtime_query({view:"needs_action"})` 查待处理事项，`runtime_query({view:"review"})` 查待复核结果。查询仅限当前所有者的保留记录，不搜索输入或结果正文，不自动执行后续操作。全部参数、分页和示例见[协议](<docs/protocol.md>)。

## 使用边界

- **计划限制**：最多 32 步、64 KiB，并发 1–4。支持 `read/glob/grep/edit/write/pwsh`，仍受 DSH 权限与沙箱约束；超时与重试参数见[协议](<docs/protocol.md#计划plan>)。
- **同步调用**：普通插件调用应同步等待；携带宿主准入集合（`exec.toolSet`）的计划不能异步脱离该集合。受控宿主的例外见[协议](<docs/protocol.md#状态取消与关闭>)。
- **取消与恢复**：取消会停止新调度并传播信号，但不保证已开始的宿主操作停止或回滚。不保证 exactly-once（副作用恰好发生一次），未知副作用和未知 Agent 不自动重放。自动转后台的命令仍须由主助手通过原生 Job 工具收集或停止。
- **保存与隐私**：运行记录默认位于 `DSH_HOME/tmp/xiaohe-runtime/runs`，可用 `XIAOHE_RUNTIME_DIR` 覆盖；保留最新 100 条终态，保护运行中和中断记录。输入与结果可能包含敏感内容，应保护记录目录。单步结果超过 64 KiB 仅保留截断标记，分页不能恢复原文。
- **结果判读**：运行成功不等于任务通过；复核声明不等于用户批准，投递回执不等于收件人已读。
- **Worker 扩展**：仅显式接入可信 `DelegationPolicyAdapter` 的受控宿主集成可创建独立只读 Worker。标准入口报 `RUNTIME_AGENT_POLICY_UNSUPPORTED`，不能删父策略或修改已安装宿主绕过。扩展契约见[协议](<docs/protocol.md#agent-步骤受控宿主集成>)。

组件回归不代替真实桌面 GUI、真实模型和实际 OS 沙箱验收；这些环境验证仍未完成。测试范围与局限见[验证说明](<docs/validation.md>)，错误判读见[故障处置](<docs/OPERATIONS.md>)。

## 继续阅读

| 读者 | 文档 |
|---|---|
| 使用者 | [工具与运行协议](<docs/protocol.md>) · [状态与故障处置](<docs/OPERATIONS.md>) · [兼容性](<docs/host-compatibility.md>) |
| 开发者与宿主集成者 | [运行时设计](<docs/DECLARATIVE-RUNTIME.md>) · [产品结构](<docs/PRODUCT.md>) · [验证范围](<docs/validation.md>) · [流程试验](<docs/FLOW-TEST.md>) · [发布流程](<docs/RELEASING.md>) |
| 版本与设计记录 | [全部发布说明](<docs/releases/>) · [研发路线](<docs/DEVELOPMENT-PLAN.md>) · [原型对照与取舍](<docs/SUPERAGENT-COMPARISON.md>) |
| 旧总线历史 | [0.x 复盘](<docs/RETROSPECTIVE.md>) · [第三方整合记录](<docs/INTEGRATION.md>) |

从源码构建、测试或打包，请按[维护者流程](<docs/RELEASING.md#2-本地验证>)选择 Node.js 版本并执行检查。

## 许可与反馈

本项目采用 [MIT License](<LICENSE>)，允许商业使用、修改和分发；分发时须保留版权及许可声明，具体以完整许可为准。依赖项遵循各自许可，见[第三方说明](<THIRD_PARTY_NOTICES.md>)。

发现问题或希望改进使用体验，可在 [GitHub Issues](<https://github.com/f-e-n-g-0531/dsh-execution-bus/issues>) 提供 DSH 与插件版本、最小复现步骤及脱敏错误信息；不要公开凭据、私有输入或完整敏感运行记录。
