# 第三方说明

本包没有捆绑 DSH、Cordis、TypeScript、测试依赖或宿主源码快照。DSH 与 Cordis 作为宿主 peer 使用，其独立包分别受原许可证约束，本项目非商业许可证不限制第三方已授予的权利。开发依赖不进入本项目 tgz。js-yaml 为 MIT 许可的独立运行依赖，由包管理器按声明安装，不捆绑进 tgz；其源码和许可见 https://github.com/nodeca/js-yaml ，本项目许可不限制其原有权利。

CI 与发布组织方式参考 dsh-vcs，并按本项目执行能力重新实现；本包不含 Monaco、React 或 SVN 实现。

0.5.0 定向参考 dsh-llm-rate-limit（MIT，hanruochong）、dsh-nightshift（MIT，contributors）和 dsh-input-traffic（MIT，contributors）的准入、生命周期和会话视图原则，按本项目契约自行实现，没有复制其源码或捆绑依赖。AsyncGate 与 cc-multi-process-mcp 仅用于边界比较，所查快照未发现 LICENSE，不复制代码。固定来源与阅读范围见 [整合说明](<docs/INTEGRATION.md>)。

0.12.0 定向阅读 Temporal（文档；SDK MIT）、Restate（文档；BUSL-1.1，未复制代码）、DBOS（文档；Transact MIT）、Oban（Apache-2.0）、BullMQ（MIT）与 Resilience4j（Apache-2.0）的公开文档/README，按本插件边界重新实现调度隔离与资源互斥，没有复制第三方源码或新增运行依赖。fast-check（MIT，dubzzz）仅作为开发依赖用于属性测试，不进入本项目 tgz。
