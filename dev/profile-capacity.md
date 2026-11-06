# 容量调用归因（开发工具）

先由构建负责人准备当前完整dist。只在可丢弃的独立Node进程运行，不在真实DSH或同时执行其他代码的宿主里调用。工具临时替换进程级同步fs绑定；它不是生产遥测或沙箱。

```powershell
node dev/profile-capacity.mjs --size 1000 --ratio 0.5 > artifacts/capacity-profile.json
```

`--size`默认100，整数1–1000；`--ratio`默认0.5，0–1，表示既有interrupted与失联running总比例（向下取整，再约一半各类）。不安装、不自动构建、不调用模型，不支持任意目录或任意命令。每个list/prune/startup使用独立临时历史；startup指RuntimeService构造（含realpath/maintain），不含进程启动或模块加载；warm-list紧跟list，同实例、同历史。验证在暖查询之后，计数不含setup、验证、dispose与最终目录清理。

## 输出

每个操作保存同步测量窗墙钟耗时、十个fs API的调用量/异常量/包裹耗时，以及原存储错误诊断增量。验证终态、running/interrupted数、unknown步骤及列表数量，失败标记并将wallTimeMs设null；部分失败API调用可由底层正常处理，不能将每个API失败自动解释为操作失败。若顶层构建、验证读取或清理异常，CLI只输出固定错误并退出1，不生成伪完整报告。四项操作完成但验证/操作失败则退出2，均通过退出0。

- 这是JavaScript同步API调用计数，不是内核syscall数。writeFileSync等实现可能嵌套调用被包装的其他fs方法。
- totalMs为包含嵌套工作的包裹墙钟耗时，彼此可能重叠，**不能相加、不能从操作耗时相减推算CPU/解析成本**。探针本身有开销，不作未插桩性能对照。
- 当前只包含已知十项同步fs入口，不包含所有Node内部IO、native路径或第三方工作。扫描与校验阶段可能共用同一个fs API，不能仅凭readSync判定是扫描还是fresh读取。
- 同进程模块级metadata仍存在，独立root不等于OS冷缓存。没有机器独占、收益SLA、真实桌面/模型/实际沙箱认证。
- 摘要覆盖探针、归因入口、原基准/统计和当前 11 个已知本地运行时执行文件（旧版六文件必需，retry、agent、agent-report、agent-trace、worker-quota 五模块可缺省；摘要区分缺失与存在，仅 ENOENT 视为缺失）。启动/结束检测持续修改，但不认证已加载模块、第三方依赖或改后恢复；请在源码冻结后新进程启动。
- 探针拒绝嵌套和thenable，但不能取消已经开始的异步副作用，不能接收async工作。仅接受已知同步函数。返回value仅供调用方内部处理，公开报告只保留固定合成数量。

工具与说明均位于dev，不随npm包发布。先用小历史验证调用量，再扩大到1000；不将单次受探针影响的耗时写成提速结论。
