# 萧何 / Xiao He

**给 DeepSeek Harness（DSH）的多步骤工具任务加上依赖调度、运行记录和可核查的恢复流程。**

模型说明“做哪些步骤、先后有什么依赖”，萧何负责执行与保存结果；主助手（Lead）负责判断结果、继续修改和验收。适合把已经明确的重复操作交给运行时，而不是让模型每次重新编写调度代码。

DSH 插件：`@feng0531/dsh-execution-bus` · 当前版本 **1.7.1** · [版本变化](<docs/releases/1.7.1.md>)

> **使用前先确认：**本版面向 **DSH 0.2.2-rc.1**。标准插件支持普通工具 DAG（按依赖连接的步骤图）；**独立只读 Worker 不可直接使用**，含 agent 的计划会因缺少可信父策略适配器而拒绝。非商业用途按[许可证](<LICENSE>)使用，商业用途须另行取得书面授权。

## 为什么使用萧何？

- **少写调度代码**：用计划声明步骤和依赖，独立步骤可并行，前置成功后再执行后续步骤。
- **结果可追溯**：每步保存检查点，按运行或任务查看状态、结果与下一步待办。
- **只读失败可控重试**：仅 `read/glob/grep` 支持有限重试；确定性错误和超时不会盲目重试。
- **中断后不冒险重放**：显式恢复可重排在途只读步骤；遇到未知写入、命令或 Agent 状态停止恢复，先核实实际影响。
- **执行与验收分开**：运行成功不等于任务完成；已知悉、决策处置和结果复核各有记录，不互相冒充。

它不是分布式工作流服务、后台常驻代理或自动开发平台，也不替代 DSH 的授权与沙箱。

## 适合谁？

**推荐给**已使用目标版本 DSH、希望组织明确多步骤流程的非商业用户，例如：

- 并行读取多份文件，收齐结果后由主助手分析；
- 按固定顺序执行检查、收集诊断材料，并保留每步结果；
- 跟踪同一任务的多次运行，查找待处理问题和待复核结果。

**不必为了这些场景安装：**一次简单读写、仍在探索的任务、跨机器调度，或期望安装后即可让多个 Agent 自主修改和发布代码。简单操作继续使用原工具更直接。

## 安装与启用

### 1. 确认环境

- DSH **0.2.2-rc.1**、Node.js **22 或更高版本**；不推导兼容其他 DSH 版本。
- 宿主已有声明式 ptc 预设。萧何从它派生独立预设，不覆盖原 PTC 或全局工具。
- 宿主依赖目标与已知告警见[宿主兼容性](<docs/host-compatibility.md>)。

### 2. 安装插件

在目标 DSH 配置使用的包环境中执行：

```text
npm install --ignore-scripts @feng0531/dsh-execution-bus@1.7.1
```

将包加入该配置的 `dsh.profile.bundles`，或通过宿主插件管理器加载 bundle。加载后选择 **萧何 / Xiao He**，预设 ID 为 `xiao-he-runtime`。安装 npm 包本身不等于已加载 bundle；发布新版本也不会自动升级或重启你的 DSH。

首次使用建议先在隔离配置验证，不替换日常环境。授权与沙箱仍由宿主管理，插件不会接管原有终端、编辑或全局工具。

## 第一次使用

可以向主助手这样描述任务：

> 用萧何并行读取 README.md 和 package.json，保存每步结果，再由你总结项目用途与运行要求。先查询能力，只使用普通工具，不创建 Worker。

运行顺序：

```text
明确任务 → 查询能力 → 提交步骤计划 → 按依赖执行并保存结果 → 主助手读取与核实 → 交付结果
```

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

由主助手调用 `runtime_run`，输入为 `{plan: 上面的计划}`。默认同步等待，返回运行 ID 和步骤状态；实际内容通过 `runtime_result({runId})` 读取。`runtime_capabilities({})` 可先查询能力，但查询不是授权或容量预留。

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

- **计划大小**：最多 32 步、64 KiB，并发 1–4；单步超时 1–600 秒，只读重试最多 3 次。直接工具步骤支持 `read/glob/grep/edit/write/pwsh`，仍须通过宿主准入。
- **同步调用**：普通插件调用应使用同步等待。携带 `exec.toolSet` 的普通计划不能异步脱离准入生命周期；仅无该集合的受控宿主调用可使用普通 DAG 异步接口，不得删除准入集合绕过限制。
- **取消与恢复**：取消会停止新调度并传播信号，但不保证已开始的宿主操作停止或回滚。不保证 exactly-once（副作用恰好发生一次），未知副作用和未知 Agent 不自动重放。自动转后台的命令仍须由主助手通过原生 Job 工具收集或停止。
- **保存与隐私**：运行记录默认位于 `DSH_HOME/tmp/xiaohe-runtime/runs`，可用 `XIAOHE_RUNTIME_DIR` 覆盖；保留最新 100 条终态，保护运行中和中断记录。输入与结果可能包含敏感内容，应保护记录目录。单步结果超过 64 KiB 仅保留截断标记，分页不能恢复原文。
- **复核与通知**：accepted 是所有者声明，不是独立验收或用户批准；通知 sent 也只是投递方声明。通知工具本身不发送消息，不自动重发未知投递。
- **Worker 扩展**：仅显式接入可信 `DelegationPolicyAdapter` 的受控宿主集成可创建独立只读 Worker。标准入口报 `RUNTIME_AGENT_POLICY_UNSUPPORTED`，不能删父策略或修改已安装宿主绕过。扩展契约见[协议](<docs/protocol.md#agent-步骤受控宿主集成>)。

组件回归不代替真实桌面 GUI、真实模型和实际 OS 沙箱验收；这些环境验证仍未完成。测试范围与局限见[验证说明](<docs/validation.md>)，错误判读见[故障处置](<docs/OPERATIONS.md>)。

## 继续阅读

| 读者 | 文档 |
|---|---|
| 使用者 | [工具与运行协议](<docs/protocol.md>) · [状态与故障处置](<docs/OPERATIONS.md>) · [兼容性](<docs/host-compatibility.md>) |
| 开发者与宿主集成者 | [运行时设计](<docs/DECLARATIVE-RUNTIME.md>) · [产品结构](<docs/PRODUCT.md>) · [验证范围](<docs/validation.md>) · [流程试验](<docs/FLOW-TEST.md>) · [发布流程](<docs/RELEASING.md>) |
| 版本与设计记录 | [1.7.0 发布说明](<docs/releases/1.7.0.md>) · [全部发布说明](<docs/releases/>) · [研发路线](<docs/DEVELOPMENT-PLAN.md>) · [原型对照与取舍](<docs/SUPERAGENT-COMPARISON.md>) |
| 旧总线历史 | [0.x 复盘](<docs/RETROSPECTIVE.md>) · [第三方整合记录](<docs/INTEGRATION.md>) |

从源码验证：

```text
npm ci --include=dev --ignore-scripts
npm run check
npm run verify:package
```

隔离安装检查和发布操作另见开发文档，不要将示例命令用于未经确认的日常宿主环境。

## 许可与反馈

本项目采用[非商业源码公开许可证](<LICENSE>)，**不是 OSI 认可的开源许可证**。公司内部开发商业项目、有偿交付、商业产品集成等用途也需要书面授权；具体以完整许可为准。依赖项遵循各自许可，见[第三方说明](<THIRD_PARTY_NOTICES.md>)。

发现问题或希望改进使用体验，可在 [GitHub Issues](<https://github.com/f-e-n-g-0531/dsh-execution-bus/issues>) 提供 DSH 与插件版本、最小复现步骤及脱敏错误信息；不要公开凭据、私有输入或完整敏感运行记录。
