# 协议 v1、状态与投递

## 输入

严格无损 JSON，最大 16 KiB，不接受额外顶层字段。JSON 值最大深度 64、访问节点最多 65536；拒绝非有限数字、负零、undefined、函数、符号、稀疏数组、访问器属性、特殊对象和循环引用；数组只接受当前运行域的原生 Array.prototype，拒绝数组子类、自定义原型及跨域数组。messageId / requestId 为 1–128 位字母、数字、下划线、点、冒号或短横线。


type 为 request 时 payload 为 {handler,input}；type 为 status / result / cancel 时 payload 必须为 {}。不支持其他类型或版本。sessionId、权限、工作目录不能出现在输入中，可信归属只能由宿主工具上下文绑定。

- messageId 标识一条消息；同请求内同 messageId 不同内容拒绝。普通消息记账最多 128 条，超过拒绝普通新消息。首次有效取消可使用额外一个保留槽，最多 129 条；之后的新取消不再增加记账，已记录消息 ID 的冲突检查仍生效，不会因查询耗尽额度而丧失取消路径。
- requestId 是一次逻辑操作的稳定幂等键；作用域为当前插件实例 + 宿主 session。相同 requestId 不同 handler/input 拒绝冲突，相同输入使用新 requestId 仍是新操作。
- 输入规范排序后的摘要仅用于同 requestId 冲突比较，不作永久参数去重。保存期后旧键会失效，调用者不得因此盲目重跑有副作用操作。
- callId / rootCallId / Agent / parent token 来自宿主；通过工具原本的 Promise 关联结果，不依赖模型提供的身份。

## 输出

核心 submit 返回 accepted 事件和 done Promise。受理只意味着已进入内存记录和队列，durable:false；不是成功。事件包含 protocolVersion、messageId、requestId、correlationId（首次请求 messageId）、sequence、type、payload。每请求 sequence 单调递增，accepted 是当前序号的快照，不占新增序号。

事件类型：accepted、started、progress、cancel_requested、succeeded、failed、cancelled、unknown。进度只接受 Handler 正整数序号递增的百分比，重复、乱序、终态后进度丢弃。进程内投递，无外部消息接收端，也不支持任意远端终态注入；终态只由总线持有的执行 Promise 结算。事件及其 payload 在投递前深度冻结，观察者不得修改请求关联、序号、类型或进度内容。每个附着拥有独立观察者注册和名额，即使复用同一回调；detach 幂等且只移除自己的通知，不影响其他附着或执行结果。观察者是最佳努力通知：同步抛错及异步 Promise 拒绝均被隔离，不记录异常原文；不等待观察者完成，不保证关闭前异步通知已经完成，观察者须自行管理资源。

工具的 request 保持 pending，最终返回 RecordView（requestId,state,sequence,cancelRequested,delivery,result?,error?,progress?）；status/result/cancel 返回同一种当前快照。工具不会提前返回 accepted 或 taskId，也不会用聊天进度消息唤醒模型。Job 的 UI progress 只含状态/百分比。

## 状态转换

queued → running → succeeded / failed / cancelled / unknown。
queued → cancelled。终态不可变；取消终态任务只返回原状态。

运行中取消先置 cancelRequested 并触发 AbortSignal，不立即声称 cancelled。Handler 用 AbortError 确认取消后才 cancelled；收到取消仍成功返回则 success 获胜；取消后其他异常为 unknown。Handler 必须合作取消并等待自身资源停止，不能把部分副作用当作已撤销。初版内置 Handler 仅为受控测试和只读宿主 read，没有非幂等写操作。

异常是固定错误码，不将异常堆栈/原文写日志。结果遵守同样的严格 JSON 深度/节点与值约束；过大、会丢失信息或不可保存的结果进入 unknown / RESULT_NOT_RETAINED，不因结果传输失败自动执行一次。执行结束不等于交付，delivery 单独记录 pending / returned；returned 仅代表插件已走到工具返回路径，**不是会话持久化提交确认**。done 快照保留当时的 pending，后续查询可见 returned。宿主可能因取消/后置策略改变最终工具结果，插件不声称已确认模型收到。

## 容量和清理

默认并发 2，待分发队列 32，记录 256，单结果 JSON 64 KiB；所有请求先经上限检查，满则 BACKPRESSURE，不自动重试。Job 仍受宿主自己的每 owner 容量限制。队列不提供公平性 SLA，单会话可占满实例。core 不传配置时使用默认值；传入配置必须完整包含五项正安全整数，不接受部分配置、额外字段或访问器，缺项立即 INVALID_OPTIONS。core 构造时复制并冻结容量配置，之后修改调用方原对象不改变总线限制；没有动态配置更新接口。重复附着只有成功取得观察者名额后才提交新消息记账，WAITER_LIMIT 拒绝不占用消息 ID 或额度。

终态自完成后保存一小时；新受理及控制消息查询时惰性清理，可通过 core.sweep 主动清理。无定时器常驻、无磁盘结果存储、无日志输出。插件关闭先停止受理，取消队列与运行任务，等待合作 Handler，清理内存；不合作的 Handler 会阻碍关闭，插件无法安全硬杀同进程代码。

敏感文件结果仍可能进入宿主原有工具会话日志，本插件不具备任意文本秘密识别能力。只请求确实需要的内容；不将敏感内容放入请求标识。结果长度检查发生在 Handler 返回后，扩展 Handler 自身也必须限制分配，不可把此检查当成防止超大对象构造的内存沙箱。

## 投递语义、超时和恢复

在同一个存活实例/保存期内，同 session + requestId 多次投递共用一次执行；每个实际工具调用独立取得一次响应。这不是端到端 exactly-once，同一请求重复调用仍会增加宿主工具调用记录。终态状态和结算锁避免一次执行被重复完成；不会额外主动提交会话结果。

无网络传输层，因此自动通信重试次数为 **0**，也不自动重试执行。宿主 Job 60 秒窗口超时只是程序续等，不改变执行状态、不触发模型查询。PTC 外层仍有自己的时限和取消语义。

本版不做持久化：受理/运行/结果/交付任一阶段进程崩溃都会丢失插件记录。宿主日志可能记录请求和结果，不代表插件恢复了执行。跨重启需人工结合宿主 outcome unknown 和外部实际状态处理；不能自动重跑非幂等操作。本版不实现对账钩子或跨进程重试，扩展有副作用 Handler 前必须另行设计这些能力。

## 扩展 Handler

core 导出 ExecutionBus、Handler 和 Capability 类型。register(name,handler) 返回幂等注销函数，绑定唯一注册令牌；旧函数不会删除后来同名注册，即使复用同一 Handler 对象。同名活跃注册拒绝。Handler 提供 validate 和 async run，执行上下文仅有 requestId、signal、progress 与最小执行 capability，不传聊天历史。注销不影响已受理任务捕获的 Handler；关闭时等待它们。

当前插件内置注册 test 与 host.read。尚未公开 Cordis Handler 注册服务，其他插件不能假定存在 ctx.executionBus；跨插件动态注册属于后续事项。
