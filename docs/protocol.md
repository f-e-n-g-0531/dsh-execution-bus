# 协议 v1：请求、状态与结果

本文面向调用者和 core Handler 开发者。消息示例见[使用说明](<../README.md>)，兼容版本见[宿主说明](<host-compatibility.md>)。

## 1. 请求结构

```json
{
  "protocolVersion": 1,
  "messageId": "message-001",
  "requestId": "operation-001",
  "type": "request",
  "payload": { "handler": "test", "input": { "delayMs": 1000, "fail": false } }
}
```

| 字段 | 规则 |
|---|---|
| `protocolVersion` | 必须为数字 1 |
| `messageId` | 单请求范围内一条消息的编号；相同编号不同内容拒绝 |
| `requestId` | 同一逻辑执行的稳定编号；同会话内重复输入复用执行，不同输入拒绝冲突 |
| `type` | `request`、`status`、`result` 或 `cancel` |
| `payload` | request 必须为 `{handler,input}`；其他三种类型必须为 `{}` |

两个 ID 都只接受 1–128 位字母、数字、下划线、点、冒号和短横线；不接受其他顶层字段。身份、权限和工作目录不能由消息另行指定。宿主工具上下文中的 Agent、调用 ID 与 token 才是可信关联。

请求最大 16 KiB。输入和结果采用严格 JSON：深度最多 64，访问节点最多 65536；拒绝非有限数字、负零、undefined、函数、符号、稀疏数组、访问器、特殊对象和循环引用。普通对象接受当前运行域 Object.prototype 或 null 原型；数组只接受当前运行域 Array.prototype。跨运行域值须先转换为受支持的纯数据，不能假定任意 JavaScript 对象都可传入。

### 去重与消息额度

- 逻辑键是 **当前存活总线实例 + 宿主会话身份 + requestId**。不同会话不能查询/取消彼此记录；同预设仍共享容量。
- 对参数规范排序后的摘要仅用于同 requestId 的冲突比较，不用于永久按参数去重。相同参数的新 requestId 仍是新操作。
- 普通消息最多记账 128 条，含首次请求、重复请求及查询。满后拒绝普通新消息；首次尚未确认的有效取消可使用一个额外控制槽，最多 129 条。已记账消息的冲突检查不因控制槽而放松。
- 活跃观察者附着最多 32 个；每个附着独立占名额，即使共用回调。附着被拒绝时不占用新消息编号/额度。
- 终态超期清理后旧请求键失效，不应把此机制用于长期避免外部副作用重复。

## 2. 工具返回和 core 事件

**工具 request 不提前返回 accepted 或仅 taskId。** 它异步等待后返回执行快照；校验、容量、宿主服务等也可能令外层工具调用返回错误，而非执行快照。

快照字段：`requestId`、`state`、`sequence`、`cancelRequested`、`delivery`，以及可选 `result`、`error`、`progress`。`status`、`result`、`cancel` 均返回当前快照；`result` 在运行中也只返回当前状态，不额外等待。

core 的 `submit()` 返回 `accepted`、`done` Promise 和取消/解除通知/返回标记句柄。accepted 只是内存受理或已有记录的快照，`durable:false`，不代表执行成功；终态重取也不代表重新执行。

通知包含版本、消息 ID、请求 ID、关联 ID（correlationId）、请求内序号、类型与 payload。accepted 的 correlationId 对应本次提交消息，序号是当前快照；后续事件关联首次请求 messageId，新增序号。类型包括 started、progress、cancel_requested 和 succeeded、failed、cancelled、unknown 四种终态事件。

Handler 报告的进度序号必须递增；重复、乱序及终态后进度忽略，百分比须在 0–100 内。事件及 payload 在通知前冻结。每个附着独立解除通知，detach 不取消执行；取消是另一个操作。派发开始时固定本批名单，派发期间新增监听从下个事件开始接收；已解除且尚未轮到的回调跳过。回调中触发的嵌套事件按序排在当前批之后，不跨越当前通知。观察者抛错或异步拒绝被隔离，不记录异常原文，也不等待观察者资源完成。

## 3. 执行状态和交付标记

```text
queued → running → succeeded / failed / cancelled / unknown
   └────────────→ cancelled
```

终态不可再改成另一终态：

| 状态 | 含义 |
|---|---|
| queued | 内存已受理，尚未开始 |
| running | 正在执行 |
| succeeded | Handler 正常返回，结果可验证、保存 |
| failed | 未在取消中的 Handler 执行异常 |
| cancelled | 排队时取消，或运行 Handler 用 AbortError 确认取消 |
| unknown | 取消后异常未确认，或执行结果不能可靠保存 |

`cancelRequested` 只表示发出了 AbortSignal，不代表停止或回滚。取消后正常返回且结果可保存，成功可获胜；取消后其他异常保守记为 unknown。取消某个正在等待的重复调用，会请求取消整个逻辑执行，不是仅退出该等待者。

执行完成与结果交付分开。`pending`/`returned` 只是插件返回路径的标记；done 快照保留当时值，后续查询可看到更新。**returned 不证明宿主磁盘提交或模型已消费**。外层取消/后置策略仍可能改变返回值。

错误也须分层：Handler 异常原文不进入保存结果，使用 HANDLER_FAILED 等固定码；不合法、过大或快照不可保存结果为 unknown / RESULT_NOT_RETAINED。宿主 wait/remove 等服务错误可能作为外层工具错误传出，不能笼统声称所有错误都已脱敏或都是固定码。不要把宿主服务错误文本当成业务执行失败凭据。

## 4. 容量、保存与关闭

| 默认配置 | 值 |
|---|---|
| 并发执行 | 2 |
| 待分发队列 | 32 |
| 任务记录 | 256 |
| 单结果 JSON | 64 KiB |
| 终态保留期 | 自完成起 1 小时 |

新执行请求受队列和记录容量限制；运行中重复附着受消息/监听名额限制；未过期终态复用不申请新 Job。宿主新 Job 准入还有独立容量要求。已受理的排队任务按会话轮转，各会话内部 FIFO；不抢占运行任务，没有完成时间 SLA，core 未启用会话配额时单会话可占满队列；宿主插件启用每会话16项，但终态记录与多会话总量仍可占满容量，不保证其他会话一定获得入队名额。

core 不传配置时用默认值；显式配置必须完整包含 concurrency、queueLimit、recordLimit、resultBytes、retentionMs 五项正安全整数。拒绝缺项、额外字段与访问器；构造时复制冻结，无动态更新接口。

保留期通过新请求或控制消息触发惰性清理，也可调用实例 `sweep()`；不是精确的一小时定时删除，闲置时记录可能继续占内存，但后续正常查询会先清理过期记录。无磁盘任务库。结果大小检查在 Handler 返回后进行，Handler 自身也必须限制内存分配。敏感返回内容仍可能进入宿主会话日志，本插件不是秘密识别器。

关闭幂等且可重入，多次 close 返回同一 Promise。core 先停止受理，取消队列和运行任务，排空后清理内存；宿主执行所有者继续等原工具交付路径及 Job 关联结束，再释放。等待某个 Handler 的通知回调里不应反向 await 整个关闭完成。正常路径复用 Job 窗口等待；服务异常后仍先排空执行，再有界检查记录并保留原服务错误。持续故障可能留记录到宿主生命周期清理，不合作 Handler 可能阻碍关闭。

## 5. 重试与恢复语义

当前没有网络传输层，自动通信重试与执行重试均为 0。正常 Job 的 60 秒窗口只由程序续等，不自动改为失败；异常清理有界检查也不是模型轮询或执行重试。

同存活实例、保存期内的请求复用不是端到端 exactly-once；每个实际工具调用仍有自己的宿主结果记录。没有外部终态注入接口，也没有跨重启恢复：任一阶段进程崩溃都会丢失插件内存状态。宿主日志不能复活旧 Promise，不追加聊天消息冒充原调用恢复。

## 6. 准入与会话状态（0.5.0）

原五项 core options 不变。第二构造参数 AdmissionPolicy 可含 sessionQueueLimit、maxQueueWaitMs，均为 1..2147483647 安全整数，省略表示不启用该约束。策略复制冻结，未知键和访问器拒绝。宿主插件启用每会话排队 16、排队 120000ms，普通请求不可覆盖策略。

相同 requestId 的复用先于新准入检查，不重复占槽或重置原期限。每会话超额返回 SESSION_BACKPRESSURE，不受理、不占 requestId；全局/记录容量仍优先返回 BACKPRESSURE。两者只限制准入，不保留所有会话的专用槽。终态记录仍可占满 recordLimit。

期限使用单调时钟，计时器及出队前均检查，超期只将 queued 结算 failed / QUEUE_WAIT_TIMEOUT，不调用 Handler、不设置 cancelRequested、不重试，沿原 done/Job 返回。开始运行、取消或关闭时清除计时器。事件循环繁忙会令通知晚于期限，但不会让超期任务出队执行。已运行任务继续遵守原执行/取消规则。

execution_bus_state 工具仅接受 {}，从宿主 Agent 取 sessionId，拒绝匿名或自报身份，关闭后拒绝查询。它读取 core inspect 的不可变快照，不创建 Job、不改变消息额度；查询会做正常终态 TTL 清理。不包含输入/输出，不访问其他会话。最多 50 条、活跃优先，其后按受理次序倒序列出终态；总数未截断，truncated 提示列表截断。元数据含 requestId、state、delivery、cancelRequested、固定 error/progress、waitReason、queueMs/runMs/remainingQueueMs。phase terminal 只表示执行终态且尚未标记返回，不代表可推断宿主 Job 清理进度。

core inspect(trustedOwner) 要求非空 sessionId，但不提供鉴权，可信身份和访问控制属于嵌入宿主。勿把 core 的任意 owner 参数直接暴露给远端。状态不是持久审计/模型消费回执，不应循环调用。

## 7. 诊断

core 实例的 `diagnostics()` 返回只读用途的独立快照：阶段计数、最近 128 条 `{operation,stage,elapsedMs}` 轨迹、关闭阶段、队列/运行/记录数及保留结果字节数。operation 是实例内递增数值，不是消息或会话 ID；elapsedMs 以单调时钟计算，阶段时间均相对受理时间，可相减得到排队/执行/返回延迟。复用计数仅在附着受理成功时增加；返回阶段按逻辑结果首次标记，不代表每个工具调用都持久化。

宿主执行所有者另有内部 Job 创建/释放/异常聚合轨迹，不作为模型工具或公开服务导出；其 operation 是独立编号，不能与 core 轨迹按编号关联。数据只在内存，不保存参数、结果、Handler 名称、请求/会话 ID、异常文本或聊天记录。总计数会持续累积，128 槽环形轨迹有界且按时间顺序导出；结果字节只在保存/过期/关闭时更新，查询不读取结果内容或重复序列化。异常计数不等于每次清理最终失败。

## 8. 扩展 Handler

包的 `./core` 导出 ExecutionBus、Handler、Capability 类型。Handler 只接收输入、requestId、signal、progress 和可选最小 capability，不接收聊天历史。register 返回绑定唯一注册令牌的幂等注销函数，不会误删后来同名注册；已受理请求继续持有原 Handler。

内置 test 和 host.read 没有非幂等写能力。当前没有 ctx.executionBus 服务、远端传输、跨插件动态注册或外部副作用对账契约。扩展有副作用 Handler 前必须另行设计授权、幂等与崩溃对账，不能仅依赖本版请求键。
