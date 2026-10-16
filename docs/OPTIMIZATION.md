# 引擎经验优化整合与验收

本轮统一在 0.4.0 交付，不将普通 BUG 修复冒充整体架构优化，不声称模型性能已提高。运行逻辑仅作用于萧何总线及其 Job 关联；保留 0.3.0 的 PTC 派生方式、权限和原工具能力。

## 优先级与交付

| 优先级 | 交付 | 范围与限制 |
|---|---|---|
| P1 | 执行所有权集中 | 内部 ExecutionHandle 关联 core completion、请求级取消、宿主 Job 和进度；ExecutionOwner 集中跟踪共享投影及工具交付。不是第二个执行状态机 |
| P1 | 阶段化关闭 | 停止受理 → 请求取消及排空 core → 等待活跃工具交付 → 等待并释放 Job 关联。重复关闭返回同一 Promise，先发布 closing 再触发取消，允许回调重入 |
| P1 | 通知批次边界 | 每次固定名单；新增监听从后续事件接收；解除的监听跳过；嵌套事件按请求内序号排在当前批之后。同步与异步错误继续隔离 |
| P2 | 有界脱敏诊断 | core diagnostics 快照及内部 Job 聚合轨迹。每个环最近 128 条；只存数值编号、阶段、耗时、计数，不存业务内容 |
| P2 | 会话轮转 | 两会话积压测试确认 FIFO 的队头延迟后，实现受理后轮转；保持会话内 FIFO 和并发上限，无入队公平保证或时间 SLA |
| 暂缓 | 按资源串行 | 没有真实写 Handler，不引入资源锁；PTC 原工具不被全局接管 |
| 不做 | 工作流/线程系统 | 不加入 DAG、线程池、无锁队列、对象池或按引用数自动取消 |

## 实测证据及不能推导的结论

确定性压力用例中，A0 已运行，A1–A12 排队后 B0 入队：

```text
原 FIFO： A0,A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11,A12,B0
会话轮转：A0,A1,B0,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11,A12
```

这是已受理任务的开始顺序对比，不是生产延迟、吞吐或模型轮次提升比例。运行任务不可抢占，新会话可能仍因队列满被拒绝。同一会话多个长任务也可能占用并发槽，轮转不等于资源配额。

另外验证三会话、并发为二、取消一个排队任务：只执行其余 23 个不同请求，未超过并发上限，同会话开始顺序保持 FIFO。已有真实宿主等待/清理故障与卸载回归继续执行，不以纯 core 测试替代。

## 如何查看诊断

从包的 ./core 使用 ExecutionBus，调用 `bus.diagnostics()`。这不是新的 Agent 工具，也不提供跨会话读取入口；生产插件内部所有者的诊断尚未公开为服务或 UI。

阶段 elapsedMs 相对于本次受理的单调时钟时间：started 减 accepted 为排队时间、terminal 减 started 为执行时间、returned 减 terminal 为首次返回标记延迟。cancel_requested 与 terminal 间隔只能解释为取消请求到执行终态，未必为成功取消。

从 0.4.1 起，结果字节在保存时缓存、记录过期和关闭时扣除/归零；查询不再遍历记录或序列化结果。诊断写入使用 128 槽固定环，读取时才按时间顺序复制最多 128 条。环形轨迹不会记录结果内容，但仍是内部运行信息，不作为可信审计/授权依据。进程关闭后不恢复。

## 引擎经验来源

- [Bevy Task v0.16.1](https://github.com/bevyengine/bevy/blob/v0.16.1/crates/bevy_tasks/src/task.rs)：区分任务完成、取消和 detach；没有照搬 Rust Drop 语义。
- [Bevy CommandQueue v0.16.1](https://github.com/bevyengine/bevy/blob/v0.16.1/crates/bevy_ecs/src/world/command_queue.rs)：先确定消费边界再调用外部代码；未移植 unsafe/字节布局。
- [Godot 4.4 MessageQueue](https://github.com/godotengine/godot/blob/4.4/core/object/message_queue.cpp)：派发重入与消费位置的明确约束。
- [Godot 4.4 WorkerThreadPool](https://github.com/godotengine/godot/blob/4.4/core/object/worker_thread_pool.h)：分阶段关闭；没有增加线程池。
- [Unity Addressables](https://docs.unity3d.com/Packages/com.unity.addressables@1.21/manual/AddressableAssetsAsyncOperationHandle.html)：区分异步操作所有权、释放和取消，不增加模拟指针引用计数。
- [Stride Scheduler](https://github.com/stride3d/stride/blob/master/sources/core/Stride.Core.MicroThreading/Scheduler.cs)、[O3DE JobCancelGroup](https://github.com/o3de/o3de/blob/development/Code/Framework/AzCore/AzCore/Jobs/JobCancelGroup.h)：作为调研参考，分支链接可变；不宣称固定 SHA 或已构建这些引擎。

本项目是依据原则自行实现，没有复制这些引擎的源码或引入其运行依赖。
