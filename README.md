# 执行总线 / Execution Bus

DSH 独立插件 **@feng0531/dsh-execution-bus 0.1.1**，用于让模型提出一次执行请求后，由程序排队、等待和收集结果，而不是反复询问是否完成。

**当前是第一阶段可运行原型、部分完成，不是完整生产验收。只做插件，不修改 DSH。** 不增加模型或 Agent，不是工作流引擎、PTC 包装或任意命令执行服务，也不会改动其他插件。它不能解决模型理解错误、不断改变方案等所有推理问题。

## 已实现

- 版本化协议和运行时校验；有界 FIFO、并发限制、请求冲突检测、同请求执行复用。
- 原工具调用异步等待终态；复用宿主 Job 进度、取消和等待，无模型轮询。
- test：延迟、百分比、成功、失败、合作取消。
- host.read：出队时通过宿主工具注册表调用现有 read，保留当前身份、工作目录、权限及输出限制，不自行读文件或启动进程。
- 内存结果保存、大小限制、清理和关闭；失败日志不包含异常原文。

## 明确不支持 / 未验证

- 不持久化，不支持重启保留队列或恢复原工具调用，不自动重跑。
- 真实 AgentLoop 内存会话提交/继续已通过脚本适配器验证；GUI 实际展示、真实模型继续推理、磁盘会话提交与 PTC 完整链路未验证。
- 没有外部 Handler 传输、跨插件 Handler 服务、非幂等执行对账；不是全要求验收完成版。

详见 [宿主调用链与兼容性](docs/host-compatibility.md)、[协议和状态](docs/protocol.md)、[验证记录](docs/validation.md)。

## 构建与测试

需要 Node.js >=22（本次使用 24.21.0）和 npm。开发环境依赖安装限定本仓库，不触及日常 DSH。

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm pack --ignore-scripts
npm run verify:package
npm run test:install
```

标签 CI、四矩阵测试与受控发布见 [发布流程](docs/RELEASING.md)。采用[非商业源码公开许可证](LICENSE)，非 OSI 开源许可证；正式发布必须通过同标签 CI 和工作流门禁。发布不安装或重启 DSH。

测试会在隔离 Cordis 上下文运行真实宿主组件；Agent 身份为夹具，不调用真实模型。安装包只含编译入口、类型与文档，不包含宿主源码快照、测试环境或 node_modules。源码构建需要整个仓库。

## 安装：仅在你明确决定的隔离 DSH 配置中

本次**未安装到你的 DSH**。兼容目标精确为 DSH 0.2.0-rc.2 / Cordis 4.0.4；先确认你要操作的配置目录和宿主实际版本。不要向运行时安装目录复制文件或修改 ASAR。

1. 备份目标配置文件、依赖声明和 lockfile，记录当前插件清单。先停止目标隔离实例的工作，不动日常会话。
2. 在隔离配置的依赖目录安装本地 tgz，禁用生命周期脚本；避免升级宿主依赖。若 peer 不匹配，停止安装，不用 force/legacy-peer-deps 绕过。
3. 在目标实例已有的插件加载配置中加入包名。必须位于可见 tools、jobs、现有 tool-jobs controller 和 read 的组合内。包导出标准 Cordis name / inject / apply；不提供未验证的全局配置键。
4. 由使用者自行启动/重载隔离实例，确认 execution_bus 工具可见。配置结构随宿主组合而异，不承诺“一条配置适用于所有版本”。

## 使用

直接工具入口 execution_bus 的请求参数：

```json
{
  "protocolVersion": 1,
  "messageId": "message-001",
  "requestId": "operation-001",
  "type": "request",
  "payload": {"handler": "test", "input": {"delayMs": 1000, "fail": false}}
}
```

调用会等待约一秒，再返回 succeeded 等终态，不需要 status 循环。真实只读任务把 payload 改为 {"handler":"host.read","input":{"file_path":"README.md","limit":20}}，路径相对于可信宿主会话工作目录。

若当前 DSH 是 PTC 模式，在 run_code 内 await tools.execution_bus(同上对象)，而非直接工具调用；这不会解除 run_code 的时间预算。PTC 端到端尚未验收。

手工查询/重取/取消：保留 requestId，换新 messageId，type 改为 status / result / cancel，payload 为 {}。不同会话无法读取或取消其他会话请求。cancelRequested 不等于已取消；读取执行状态字段判断。不要因为等待或通信超时就换 requestId 重新执行。

## 卸载与回滚

先停止新请求并等待已有操作终态，或请求合作取消。然后从目标隔离实例插件加载配置移除包名，按宿主正常生命周期卸载；卸载会取消并等待本插件受理的任务。不要强杀并假定外部操作已回滚。

若首次试用失败，恢复前述配置/依赖/锁文件备份，再由使用者自行启动目标实例。tgz 不写宿主文件、系统服务、全局命令或磁盘任务库，无专属磁盘数据迁移。进程关闭会丢失内存结果；宿主已有会话日志不在插件卸载范围内，不删除它们。

## 减少反复的验证

真实模型参与轮次、主动状态查询次数、重复执行次数和总耗时对照：**未验证**，不提供提升比例。自动化测试只证明等待和状态机制，不替代同条件真实模型对比。
