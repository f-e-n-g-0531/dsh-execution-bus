# 同类项目源码参考与整合（0.5.0）

## 本轮交付

以本项目 0.4.1 为基线，固定五个候选仓库提交，阅读相关源文件和测试，不将“看过 README”表述成源码审计或全部项目验收。没有运行这些第三方项目的测试，没有合入其整个插件或直接复制源码。

1. **会话准入配额**：宿主插件每会话最多 16 个排队请求，全局 32 不变；相同请求复用不占新槽，拒绝不保留 requestId。不是为每个会话预留槽位，不限制已运行数或终态记录数。
2. **排队等待期限**：宿主插件默认 120 秒。计时器和出队前均使用单调时钟检查；只有尚未运行任务超时才 failed / QUEUE_WAIT_TIMEOUT，不调用 Handler、不重试。运行任务继续等待或合作取消。
3. **会话只读快照**：新增 execution_bus_state({})，可信 Agent 身份由宿主提供。只返回本会话元数据，最多 50 项、活跃优先、其余最近受理终态优先；不返回输入/结果，不创建 Job，不增加后台轮询。没有 UI 面板或额外 HTTP 路由。

原 core 五项 options 与默认策略不变，新增第二构造参数 AdmissionPolicy；部署插件选择启用上述默认值。普通任务无权覆盖策略，宿主授权、PTC 原工具和 Job 生命周期不变。

## 固定来源、实际阅读范围与采用判断

| 来源（固定提交） | 相关文件/范围 | 采用与不采用 |
|---|---|---|
| [dsh-llm-rate-limit / 8222d017](https://github.com/Asong6824/dsh-llm-rate-limit/tree/8222d0179a64c898986c69062ca86d998873e756) | src/index.ts 的配置校验、settleEntry、pump、acquire、cancelQueued、release、卸载；src/invariant.ts；tests/rate-limit.spec.ts 的准入、取消、超时和卸载用例 | 参考“有界准入、期限先于执行、卸载清理计时器后排空”。会话配额是本项目自拟适配，不宣称上游提供同样会话公平策略。不引入令牌桶、LLM 中间件或自动限流 |
| [dsh-nightshift / 35805240](https://github.com/mikasaxin529/dsh-nightshift/tree/358052402749c2830045216bdb0345250f6f32f1) | lib/queue.js 与 test/queue.test.js；index.js 的排队/运行恢复、分发锁、只读状态、卸载路径；test/index.test.js 的并发分发、状态/历史和卸载用例；client.js 前端入口及状态读取结构 | 参考“由事实源生成有界视图、活跃与历史分开”。不复制前端/HTTP；不采用崩溃后 running 重新排队、自动 retry 或 continuation |
| [AsyncGate / 36197be8](https://github.com/PStryder/AsyncGate/tree/36197be84fca835b9edca16aa46fbf2f8d694b47) | tests/test_p18_stale_lease_cannot_write.py；src/asyncgate/db/repositories.py 的按 lease_id release | 对照旧执行者不能释放新授权的原则；本项目已有注册令牌和关联对象身份检查，无需引入远端租约/数据库。本快照未发现 LICENSE 文件，不复制代码，不推断可再分发授权 |
| [dsh-input-traffic / bc4b298b](https://github.com/drscrewdriver/dsh-input-traffic/tree/bc4b298be1a831cf09a68722a8f0d0607b5a9ff8) | src/client/freeze-store.ts 的 sessionId 键控与快照隔离；LICENSE | 参考会话隔离思路，不接管输入、冻结、重排或 UI store |
| [cc-multi-process-mcp / 234823f1](https://github.com/L-x-C/cc-multi-process-mcp/tree/234823f15616d7e9c759072e940396d939f823c2) | main.py 的进程检测、信号回收、同步/异步执行、结果文件和清理路径 | 不引入自建进程池或轮询。源码的 skip_permissions 默认和 /tmp 存储不适合本插件宿主边界；未发现 LICENSE 文件，不复制代码 |

这是相关路径的定向阅读，不是五仓全量逐文件安全审核。参考快照在开发目录，明确忽略，不进入源码提交或 npm 包。
## 0.12.0 追加整合：调度隔离、资源互斥、唯一任务与属性测试

本轮以 0.11.3 为基线，读取以下公开文档/README（2026-10-18，文档站点与仓库链接；未复制源码，未新增运行依赖），只采用与插件边界相符的机制：

| 来源 | 实际阅读内容 | 采用与不采用 |
|---|---|---|
| [Temporal Workflow Id / Reuse Policy](https://docs.temporal.io/workflow-execution/workflowid-runid) | Workflow Id 唯一性、Run Id 区分、关闭后复用策略 | 参考“稳定逻辑编号 + 复用策略”分层；不引入持久化运行历史 |
| [Restate 文档](https://docs.restate.dev/)（BUSL-1.1，仅文档） | exactly-once、按 scope 的并发/流量控制、virtual object 串行化 | 参考“按类别/资源隔离并发”；不复制代码，不引入其运行时 |
| [DBOS 文档](https://docs.dbos.dev/) | durable queues、exactly-once、事务入队 | 仅对照边界；无持久化宿主契约，不实现 |
| [Oban 文档](https://oban.hexdocs.pm/Oban.html)（Apache-2.0） | 队列独立并发上限、唯一任务、10 级优先级 | 实现 Handler.queue 类别 + 优先级 + 等待老化；不引入数据库/自动重试 |
| [BullMQ README](https://github.com/taskforcesh/bullmq)（MIT） | priorities、concurrency、rate limiter、stalled jobs | 参考优先级/舱壁；不引入 Redis/停滞重排 |
| [Resilience4j README](https://github.com/resilience4j/resilience4j)（Apache-2.0） | Bulkhead、TimeLimiter | 实现 Handler.maxConcurrency 舱壁；超时暂只做 longRunning 诊断 |
| [fast-check](https://github.com/dubzzz/fast-check)（MIT，devDependency） | 属性测试 API | 新增随机序列不变量回归；仅开发依赖，不进入 tgz |

本轮实现（0.12.0）：

1. Handler 调度声明：queue、maxConcurrency、resources(input)、dedupe:"payload"；register 时校验。
2. 调度：同会话内按类别优先级（fs < diagnostic < command < default）+ 等待老化（每 30 秒削平一级，最多两级）选择；跨会话仍按会话轮转；Handler.maxConcurrency 作为舱壁。
3. 资源互斥：Handler.resources 返回稳定字符串键（host.edit/host.write 使用 file:<file_path>）；同一总线实例内同键串行，失败/取消/关闭释放；排队期限仍然有效。
4. 唯一任务：幂等 Handler 声明 dedupe:"payload"（host.read/glob/grep）；同会话同 handler+payload 已有 succeeded 终态时，新 requestId 直接复用快照并带 reused:true；失败结果不缓存。
5. 诊断：execution_bus_state 任务增加 longRunning（30 秒阈值）；waitReason 增加 resource。
6. 测试：新增 8 项调度/唯一/资源回归、2 项 fast-check 属性回归与 2 项插件级 Handler 回归。

不采用：Oban/BullMQ 的数据库/Redis 持久化、自动重试、停滞重排；Temporal/DBOS 的持久化执行与跨重启恢复（缺宿主契约）；Restate 源码（BUSL-1.1）。资源互斥仅在单个总线实例内有效，不是 OS 文件锁或跨进程保证。

许可：本轮未复制第三方源码；fast-check 作为 devDependency 使用（MIT），不进入 tgz；Restate 文档仅作机制参考（BUSL-1.1）。


## 许可与实现归属

dsh-llm-rate-limit、dsh-nightshift、dsh-input-traffic 的 LICENSE 已阅读，均为 MIT，分别保留各自权利；本轮只参考行为原则并重新实现，无第三方源码片段合入，无新增运行依赖。项目自身非商业源码公开许可不改变上游独立许可。未来复制实质代码需另行保留上游版权和完整许可。

## 验证及边界

新增 core 回归覆盖会话容量/拒绝可重试身份、满配额请求复用、队列超时不执行、运行任务不受队列期限中止、计时器延迟仍出队前拒绝、取消/关闭清理、不可变及会话隔离状态、50 项截断与活跃优先、非法策略和输入访问器。宿主 ToolRuntime 检查匿名/伪造 session 拒绝；真实 Node PTC 验证新工具绑定。

默认策略真实值由宿主组件测试核对；超时测试缩短 core 期限，未让宿主挂满 120 秒。真实 Node PTC 使用测试 Agent 和非约束策略，不代表当前桌面、实际沙箱或真实模型验收。

状态工具用于用户明确诊断，不用于等待中的模型轮询。requestId 是本会话元数据而非匿名统计，因此不要在编号里写敏感业务内容；core diagnostics 的脱敏数值轨迹仍不含请求编号。外部副作用不会因排队期限、取消或查询自动回滚。
