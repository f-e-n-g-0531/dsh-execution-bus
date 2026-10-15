# 宿主调查与兼容性

## 结论：只做插件

调查日期：2026-10-15。当前桌面安装的 runtime 和各 DSH 组件均为 **0.2.0-rc.2**，Cordis 4.0.4。源码来自安装 ASAR，只读提取到项目开发证据目录；未改安装文件。插件针对这个精确版本编译。不能据此推断旧版、新版均兼容。

**A. 纯插件可实现**：注册工具、同进程异步等待原调用、可信 Agent 归属、排队及幂等请求、调用现有 read 工具全管线、Job 进度与取消。无需模型参与等待。

**B. 当前缺少的能力（仅记录，不修改宿主）**：跨进程重新认领原工具调用的公开契约，以及工具结果写入会话日志的持久化确认。若将来宿主提供，至少需要以 session + call-event-seq + callId 进行 CAS 认领、单次提交和可查询提交凭证，且必须在中断恢复合成结果前参与恢复。现在不实现、不伪造这些 API。

**C. 本版降级**：受理、队列、结果与交付标记均为内存态。停止/崩溃后不可续接；不会自动重跑。新调用查询只能在当前插件实例的保存期内重取，不能当作恢复原调用。整体交付属于第一阶段、部分完成，不是完整跨重启总线。

## 实际调用链和源码位置

以下均为本机只读提取的**实际发布构建源码**，不是臆测的源码仓库路径。安装归档无法直接被普通文件工具当目录访问，提取脚本只向本项目写入。

1. [Agent 调度器:506–532](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L506-L532)：requireInitiator 得到 Agent，产生 callId、arguments、agent、signal；runGroup 调度且等待结果。不在等待期间请求模型。
2. [工具注册:2878–2886](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tools/lib/index.js#L2878-L2886)：ctx.tools.register 是作用域 effect，卸载自动移除。工具 execute 可以返回 Promise。
3. [可信执行身份:3131–3175](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tools/lib/index.js#L3131-L3175)：注册表生成 token，保留 callId、rootCallId、agent、signal，快照参数。
4. [前置策略:3225](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tools/lib/index.js#L3225) → [执行 waterfall 与工具体:3294–3331](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tools/lib/index.js#L3294-L3331) → [后置策略:3504](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tools/lib/index.js#L3504) → [最终 tools/result:3417](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tools/lib/index.js#L3417)。插件只调用公开 execute，不直接调用 read 的定义体，不跳过这些策略。
5. [可选 PTC:1294–1307](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tools/lib/index.js#L1294-L1307)：子调用继承 agent、rootCallId，带 parent token；在原 run_code 时间预算内等待。[超时策略:4–6](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tool-call-timeout-policy/lib/index.js#L4-L6) 是协作式取消并 drain，不代表外部副作用失败。插件不改全局工具呈现、不拦截其他工具。
6. [宿主 read:174](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js#L174)：cwd 来自 exec.agent.session.header；[实际读取和输出限制:348](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js#L348)。嵌套 read 在出队时重新进工具管线，沿用当时宿主权限和 fs 实现；插件没有独立 shell、spawn 或文件读取能力。read 的只读访问边界由宿主实际组合的 fs/权限实现决定，不能把 cwd 当作沙箱。隔离测试的 LocalFS 不等于桌面沙箱验证。
7. [Job start:412–491](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js#L412-L491)：已有 owner 校验、controller admission、输出环、进度句柄、首终态约束；[等待:510](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js#L510)、[进度:717–729](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-jobs-local/lib/index.js#L717-L729)。插件只补排队、请求冲突和结果复用，不再造通用 Job 注册表。
8. [完成通知抑制:268–270](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-tool-jobs/lib/index.js#L268-L270)：awaited 为 true 时不追加完成通知；插件先注册 wait 再等待终态，并移除已收集 Job。每 60 秒等待窗口续等由程序执行，不调用模型，不把超时改为失败。
9. [原调用结果提交:680–706](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L680-L706)：宿主将结果关联原 callId 和 call-event-seq；插件只 return，不追加 tool/result 或聊天消息。
10. [中断恢复:717–730](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-session/lib/index.js#L717-L730) 和 [interruptedTurnClosers:904](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-session/lib/index.js#L904)：为未保存结果生成 outcome unknown，不会复活内存中的 Promise。[Agent 恢复:1950](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L1950) 使用这个保守闭合机制。

## 插件扩展方式

- 工具：ctx.tools.register；服务：Cordis Service 的标准构造注册（例如 [JobRegistry:106–110](../dev/host-snapshot/node_modules/@deepseek-ai/dsh-jobs/lib/index.js#L106-L110)）。本插件没有替换宿主服务。
- 事件：ctx.on / ctx.waterfall / ctx.emit；副作用生命周期 ctx.effect，异步 disposer 用于取消并等待处理中的任务。本插件未注册全局工具拦截器。
- 界面：本版不注册自定义前端，复用现有 Jobs 进度事件和默认工具卡片。宿主原有客户端插件体系不是必需依赖；尚未完成该体系全部入口调查，不能提供未核实的 UI 注册示例。
- 持久化：宿主会话日志有持久化；本地 Job 注册表注释明确是 process-local。二者不能混同为插件可恢复执行权。

## 名称核对

- [npm 官方接口](https://registry.npmjs.org/@feng0531%2Fdsh-execution-bus) 在调查时返回 404：未发现可见同名包，不代表预留成功或拥有发布权限。
- 现有本地 origin 是 https://github.com/f-e-n-g-0531/dsh-execution-bus.git ，git ls-remote 读取 HEAD 为 06299e9425d6ba197c0d2e04bf8818ddfe471edf。仓库名称已经存在，与当前工作区既有 remote 一致，未创建、推送或修改远程；GitHub API 限流未拿到账户所有权证明。
- 中文“执行总线”和英文“Execution Bus”是描述性显示名称，不是唯一名称或商标授权结论。

## 验证分层

真实 npm 宿主组件隔离冒烟：已运行（真实 ToolRuntime / LocalJobs / read / LocalFS，测试 Agent 夹具）。
真实 AgentLoop + AgentRegistry + SessionStore 内存会话：脚本 LlmAdapter 隔离测试已通过，原工具成功结果只提交一次，再进入下一适配器请求。不是实际模型评测。真实桌面 GUI、磁盘会话持久化提交、真实模型推理续接、PTC 进程端到端：**未验证**。没有安装日常环境，也没有重启或使用模型凭据。组件测试不能替代这些结论。
