# GitHub 源码对比与诊断优化

## 调研范围

本轮对比萧何 v0.4.0（55e1d66）的队列生命周期、事件通知和诊断成本。通过 GitHub 仓库检索及 raw 源码读取，使用以下固定标签，不把 star 数作为质量证明，也未构建这些项目。

| 项目 | 实际查看内容 | 对萧何的结论 |
|---|---|---|
| [p-queue v8.1.0 实现](https://github.com/sindresorhus/p-queue/blob/v8.1.0/source/index.ts)与[测试](https://github.com/sindresorhus/p-queue/blob/v8.1.0/test/test.ts) | pending 计数、onEmpty/onIdle、abort 与 finally | 对照检查排队为空不等于运行结束；保留萧何合作取消后排空语义，不引入其超时/取消竞速直接释放槽位的行为 |
| [EventEmitter3 5.0.1 实现](https://github.com/primus/eventemitter3/blob/5.0.1/index.js)与[测试](https://github.com/primus/eventemitter3/blob/5.0.1/test/test.js) | emit 前保存监听数组长度，移除重建监听列表 | 支持为派发明确边界；萧何 0.4.0 已有批次快照、解除后跳过和嵌套事件顺序，保持自己的公开契约，不换库 |
| [Denque v2.1.0 实现](https://github.com/invertase/denque/blob/v2.1.0/index.js)与[测试](https://github.com/invertase/denque/blob/v2.1.0/test/denque.js) | head/tail 索引、容量和环绕行为 | 用同类索引思想自行实现固定 128 槽诊断环，不搬可增长 deque 或新增运行依赖 |

一次额外 deque 候选链接返回 404，未作为实现依据。参考代码不是本项目实际运行依赖；只借鉴行为和测试思路，没有复制上游源码。

## 本轮实施

1. **固定诊断环**：0.4.0 达到上限后每条事件 push 再 shift，搬移旧记录；0.4.1 使用固定槽位覆盖和游标，读取时导出最近 128 条的时间顺序副本。
2. **保留结果字节缓存**：0.4.0 每次 diagnostics 遍历记录并重新 JSON.stringify；0.4.1 复用保存时已算出的 UTF-8 字节，在终态快照保存成功后提交缓存。过期逐项扣除、关闭归零，unknown 或快照失败不计入。
3. **行为保持**：请求协议、容量、会话轮转、合作取消、关闭阶段和通知重入语义不变；不增加任务队列依赖，也不改变宿主授权。

## 可重复证据

回归 test/github-comparison.test.mjs 先在旧产物运行：

| 对比工作负载 | 0.4.0 实际计数 | 0.4.1 预期/回归结果 |
|---|---|---|
| 写入 1000 条诊断 | Array.shift 调用 872 次 | 0 次；仍只保存编号 873–1000 的 128 条 |
| 两条保存结果，查询诊断 50 次 | 额外 JSON.stringify 100 次 | 0 次，字节数完全相同 |
| 注入结果快照失败，再关闭 | unknown，不保存结果 | 字节计数保持 0；关闭 phase closed、queued/running 为 0 |

前两项优化前断言失败，第三项在前后均通过。以上是明确工作负载下的操作次数，不是耗时加速比、模型轮次或生产吞吐结论。若结果本身仅很小或诊断很少调用，实际收益也可能很小。新增字节缓存有维护成本，因此专门覆盖 Unicode、过期和失败归零。

## 暂不做

- 不用开源队列直接替换当前调度器：宿主 Job 与原工具结果排空约束不同。
- 不把 normal timeout 当作任务取消成功，不放弃仍运行的 Handler。
- 不做无锁/线程池、消息持久化或自动副作用重跑。
- 不因库测试通过就声称当前桌面、真实模型或沙箱验收通过。
