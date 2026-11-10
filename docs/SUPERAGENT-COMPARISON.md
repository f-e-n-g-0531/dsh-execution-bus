# Superagent 原型对照与结案记录

> 固定的 2026-11-09 对照与验证记录。下文“本轮”“未发布”和包版本 1.6.0 均指当时工作树，不是当前发布状态；采用的离线默认正文历史已随 [1.7.0](<releases/1.7.0.md>) 提供。固定参考基线与结案规则继续有效。

## 固定范围与状态

- 参考：[deepseek-ai/dsh-superagent-prototype](<https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4>)，提交 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`；2026-11-09 远端 HEAD 与本地 clean 快照一致。
- 对照对象：萧何提交 `7262ca0e3a2b608e8b5e8e3d9a7ad399941ab52d` 加本轮开始时实际工作树；未发布、未跟踪源码均计入已有能力，不拿已发布包代替源码。
- 目标是机制适配筛选，不是参考仓库的全量安全审计或运行认证。参考依赖早期 DSH alpha API，不直接运行或移植；没有安装参考依赖、运行其测试或启动其服务。
- 本轮采用：业务默认正文快照与离线前后比较。其余差异按下表明确结案，不保留无触发条件的“下次建议”。
- 当前状态：本轮机制筛选与采用项实现已完成，组件回归及独立静态复核完成；首轮出现一次未复现的宿主集成失败，详见验证记录。不是参考项目零缺陷证明或真实环境认证。

## 2026-11-10 明确要求的全仓重读

用户明确要求再次全仓逐行阅读，本轮重新读取同一参考基线的全部 **216 个跟踪文件、37068 行**（111 个实现、65 个测试/夹具、40 个文档/提示词/配置/锁文件）。Lead 核实参考 checkout clean、远端 HEAD 未变；五组分工与 Lead 的逐文件台账对照 Git 清单，缺失与多列均为 0。分工全文阅读不表示每个文件均经 Lead 二次逐行审计；参考测试只读未执行，不构成运行或安全认证。原有未提交测试修复保持不变。

新增维护方法候选：参考 [docs.spec.ts:58–66](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/tests/docs.spec.ts#L58-L66>) 将目录与架构的模块/测试表双向比对；当前 [文档测试](<../test/docs.test.mjs>) 检查链接、示例、版本及安全声明，尚无同类全模块职责索引约束。仅在维护导航有实际成本时考虑在现有产品文档增加简短职责/写入者/测试映射；本轮不新增目录文档或实施门禁，不强制所有 class 注释或编号链接顺序。未确认新的必要运行时功能，既有采用与不采用处置保持有效。

本轮另核实两个**仅参考原型的静态问题**：

- [registry.ts:25–34](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/registry.ts#L25-L34>) 的旧清理器可重复无条件删除同名 kind/health 映射；先注销、重注册后再调用旧清理器，会破坏新注册。内层 HealthEntry.release 幂等不保护外层。未运行复现，也不声称宿主正常生命周期会重复调用；经验是清理须幂等并绑定注册身份，不移植此注册实现。
- [settings.ts:202–212](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/settings.ts#L202-L212>) 的多次 pause/resume 产生同名同正文通知，[sessions.ts:179–185](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts#L179-L185>) 以 name+payload hash 为交付ID，[delivery.ts:65–84](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/delivery.ts#L65-L84>) 全历史去重，首次成功后的独立变化通知可被压掉。设置已保存不等于变化消息都投递；经验是事件身份和传输重试身份分开，不全局缓存相同正文。未执行真实投递，不是萧何已证实缺陷。

锁文件还存在部分 peer 绑定范围不符，以及根 Node 声明涵盖的 24.0–24.10 与构建依赖 tsdown 要求 >=24.11.0 不一致；均仅静态元数据警示，不宣称安装失败、依赖安全或跨平台验收。未修改参考源码、安装依赖或启动服务；未以这些差异重开来源平台、持久 Effects、独立编辑器、常驻 Worker 等既有不采用项。

## 统一处置

| 机制 | 萧何对应证据 | 处置与理由 |
|---|---|---|
| 任务与执行分离、关联前驱 | [plan](<../src/runtime/plan.ts>)、[service](<../src/runtime/service.ts>) | 已有；不引入 Ticket/Assignment/Mandate 工单域 |
| 来源、范围、资料引用分离 | [plan](<../src/runtime/plan.ts>) 的 provenance | 已有；调用者元数据不是授权，不自动抓取引用 |
| 不可信上下文与权限隔离 | [agent](<../src/runtime/agent.ts>)、[handoff](<../src/runtime/handoff.ts>)、[dependency-context](<../src/runtime/dependency-context.ts>) | 已有；保留可信父策略门禁，不接受 prompt 或来源消息授予权限 |
| 并发配额、清理后释放槽、停机收束、目录锁 | [worker-quota](<../src/runtime/worker-quota.ts>)、[service](<../src/runtime/service.ts>)、[root-lock](<../src/runtime/root-lock.ts>) | 已有；不照搬常驻会话和每工单 worktree |
| 陈旧结果与回调防护 | [decision](<../src/runtime/decision.ts>)、[review](<../src/runtime/review.ts>)、[notifications](<../src/runtime/notifications.ts>) | 已有 hash/revision/attempt 绑定；不全局吞并合法重复执行 |
| 只读重试、退避、等待原因 | [retry](<../src/runtime/retry.ts>)、[waiting](<../src/runtime/waiting.ts>)、[executor](<../src/runtime/executor.ts>) | 已有；超时与未知副作用不重放 |
| 容量观察、模型重试观察 | [service](<../src/runtime/service.ts>) 的 capacity、[model-wait](<../src/runtime/model-wait.ts>) | 已有；瞬时观察不是授权、容量预留或健康证明 |
| 待办优先与降噪 | [action](<../src/runtime/action.ts>)、[attention](<../src/runtime/attention.ts>)、[acknowledgement](<../src/runtime/acknowledgement.ts>) | 已有；未知副作用即使已知悉仍警示 |
| 人工决策、复核、执行完成分离 | [decision](<../src/runtime/decision.ts>)、[review](<../src/runtime/review.ts>)、[insights](<../src/runtime/insights.ts>) | 已有；自报、owner 声明均不是独立验收或人工批准 |
| 通知槽合并、显式回执、宿主发送 | [notifications](<../src/runtime/notifications.ts>)、[notification-delivery](<../src/runtime/notification-delivery.ts>) | 已有；未知投递先核验，不自动重发，不照搬持久 Effects |
| 分页任务视图、跨任务待办与元数据检索 | [history](<../src/runtime/history.ts>)、[query](<../src/runtime/query.ts>)、[presentation](<../src/presentation.ts>) | 已有；owner 隔离、先筛选再分页，不搜索敏感正文 |
| 显式上下文交接、计划变化比较 | [handoff](<../src/runtime/handoff.ts>)、[plan-diff](<../src/runtime/plan-diff.ts>) | 已有；不自动执行、复用成功或扩大授权 |
| 提示词离线预览、CAS 历史与基线漂移 | [prompt-preview](<../src/runtime/prompt-preview.ts>)、[prompt-history](<../src/runtime/prompt-history.ts>) | 已有；不增加可写模型工具或安全段覆盖 |
| 旧业务默认正文的可解释差异 | [prompt-history](<../src/runtime/prompt-history.ts>) 的 businessDefaults/defaultChanges | 本轮采用；runtime 自取两业务段快照，未知旧正文保持 unknown，摘要不带正文 |
| 持久 Effects、afterCommit、多表 SQLite 事务 | 参考 app/effects.ts、app/store.ts；当前 [store](<../src/runtime/store.ts>) | 不采用；当前按 run 原子 checkpoint，无需替换存储架构或恢复未知副作用 |
| Later 与短时容量排队、人类额外优先槽 | 参考 app/effects.ts、executor/dsh.ts | 不采用；当前有限同步调用及 fail-fast 边界明确，无实际容量平滑需求，不增加排队配置 |
| 单独组件健康板与运维总览 | 参考 infra/health.ts、app/views/overview.ts | 不采用；已有诊断/行动/查询/容量观察，累计错误不能推断当前健康，无独立运维入口需求 |
| Web 编辑器、三方草稿合并、轮询与时间线 | 参考 src/client/、app/views/ | 不采用；萧何沿用宿主展示，不为参考新建前端/HTTP 服务和配置后台 |
| 事件摄入、游标、ETag、订阅、外部身份与消息路由 | 参考 src/sources/、core/intake.ts、core/tickets.ts | 不采用；不是当前显式 DAG 的职责，不接 GitHub/飞书监听 |
| 常驻主/执行会话、自动再受理、PR 跟进与工单恢复 | 参考 app/sessions.ts、core/、executor/ | 不采用；保持短生命周期只读 Worker，不自动唤醒/重跑或引入自主工单平台 |
| 命令 shim、凭据包装、目录与 TypeScript Pick | 参考 infra/commands.ts、app/execution-environment.ts、core/engine.ts | 不作为权限边界；保留宿主真实准入与沙箱，不移植宽权限执行环境 |
| 团队自动合并、署名、评审轮数与 IM 话术 | 参考 prompts/team/、prompts/ | 不采用部署专属业务规则；本项目不自动提交、推送、合并或代替用户批准 |

## 本轮实现契约

`BusinessPromptHistory.save()` 在原有同目录原子写中保存 runtime 实际观察的 communication/delivery 默认 text/hash；不接受调用者注入默认正文。`defaultChanges(revision)` 返回两段 baseline/current 文本资料，不做二次方 LCS、自动合并或应用。

新读取器兼容没有 businessDefaults 的旧 version 1 记录，旧正文缺失始终 unknown；不回写历史、不把当前正文冒充旧版。新可选字段不兼容不认识它的旧读取器。保留 32 修订、1MiB、正文每段 8KiB、CAS、私有目录、锁、strict validation 与 summary 不泄露正文。known 仅指本地可解析且 hash 匹配，不证明可信来源或完整提示词可重放。详见[协议](<protocol.md#离线业务提示词版本历史源码新增未发布>)。

## 跨会话收口规则

同一参考基线不再反复发起“还能借鉴什么”探索。新会话先查本表；未发布不等于未实现，不采用不等于待办。仅在以下条件发生时重开受影响项：

1. 参考提交发生实质变化，先做增量差异对照；
2. 用户明确提出本表不涵盖的新需求（例如外部来源平台、编辑器或容量平滑），另定授权与验收；
3. 提供本表漏项/误判或当前实际缺陷的具体源码证据。

结案不保证零缺陷，不压制新发现的真实问题；但不能只因为存在实现差异，就把已拒绝机制重新包装成必做优化。本轮不提交、发布、安装或修改日常 DSH；真实模型、桌面 GUI 和 OS 沙箱验收不由静态对照或组件测试代替。

## 覆盖与验证

四组已完成参考实现全模块对照，结论均未发现第二项必要新增功能。当前运行时 27 个实现文件、插件注册/产品契约/展示及预设入口均已由对应分工阅读。

2026-11-09 统一验证：

- `npm run check` 首轮 642/643，通过构建；native 文件系统 DAG 的 edit 步骤返回 RUNTIME_STEP_FAILED，断言位于 [runtime-ptc.test.mjs:311](<../test/runtime-ptc.test.mjs#L311>)。本轮不改该测试或执行器来掩盖失败。
- 同用例先单独复跑 1 次通过，再完整重跑 `npm run check` 为 643/643（0 failed/cancelled/skipped），另连续单独复跑 5 次均通过。首轮根因未确定，不能据后续通过声称已修复间歇性问题；这是保留的验证局限，不是新增功能待办。
- `node --test test/runtime-prompt-history.test.mjs` 为 18/18，通过旧格式兼容、默认正文快照、未知基线、跨段隔离、跨版本比较、畸形输入与 CAS/容量/原子写回归；新增 6 组测试。
- `npm run verify:package` 核验 143 个打包文件；结案文档已列入必需白名单。`git diff --check` 通过。未进行安装 smoke、真实模型、桌面 GUI 或 OS 沙箱验收，不宣称这些完成。
- 独立只读复核完整读取本轮实现、测试及协议，对新增默认正文机制未发现阻断问题；Lead 另复读实现与输出，不将 Worker 自报等同独立验收。
- 包版本仍为 1.6.0，全部改动未提交、未发布、未安装到日常 DSH；不覆盖本轮开始前的工作树改动。

规则检索专用工具在本会话未注册，未声称已完成该项检查；实际执行遵循本会话指令、已读取项目约定与可用源码证据。

### 交付后复查（2026-11-09）

- 再次复读新增实现、测试、协议及包入口类型导出；独立只读复查未发现可证实的新缺陷，不新增借鉴功能。
- 实际参考 src 文件与本页清单逐项比对：111 个文件、111 个唯一条目，缺失/多列均为 0；36 个本地链接目标均存在。参考 checkout 仍为固定提交且 clean。此项复查是清单核验，不冒充重新逐行审计参考全部源码。
- 重新执行 `npm run check`：643/643，0 failed/cancelled/skipped；`npm run verify:package`：143 个文件；`git diff --check` 通过。本轮源码内容与前次最终指纹一致。
- native/PTC 宿主集成文件另行完整执行 9/9 通过。首轮 native edit 失败本次全测与专项均未复现。保存的运行摘要只有 RUNTIME_STEP_FAILED，不能据此确定 FS_STALE_VERSION、Windows 文件占用或其他宿主原因；仍保留为根因未知的间歇性验证局限，不标为已修复。只读追查未发现 fixture 同目标并发证据；Windows 已有文件替换另经过 DACL/ReplaceFileW，但可达路径不是故障证据，不能归因为锁、杀软或权限。
### 实现文件覆盖清单

下列为分工逐文件完整阅读的参考 `src/` 清单；四组共 111/111 文件，无实现文件遗漏。Lead 复核分工报告和本轮变更，不将“分工已读”夸大为每一文件均由 Lead 二次逐行审计。附带模板、文档与测试用于核对产品边界和候选机制，不宣称参考仓库 tests/ 全覆盖或已执行。

#### core（17 文件）

- [src/admission.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/admission.ts>)
- [src/core/assignments.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/assignments.ts>)
- [src/core/engine.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/engine.ts>)
- [src/core/errors.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/errors.ts>)
- [src/core/evals.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/evals.ts>)
- [src/core/ids.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/ids.ts>)
- [src/core/index.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/index.ts>)
- [src/core/intake.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/intake.ts>)
- [src/core/memory.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/memory.ts>)
- [src/core/model.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/model.ts>)
- [src/core/part.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/part.ts>)
- [src/core/ports.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/ports.ts>)
- [src/core/reasons.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/reasons.ts>)
- [src/core/replies.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/replies.ts>)
- [src/core/stage.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/stage.ts>)
- [src/core/tickets.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/core/tickets.ts>)
- [src/policy.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/policy.ts>)

#### runtime（15 文件）

- [src/app/cache.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/cache.ts>)
- [src/app/effects.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/effects.ts>)
- [src/app/migration.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/migration.ts>)
- [src/app/passes.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/passes.ts>)
- [src/app/retry-health.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/retry-health.ts>)
- [src/app/runtime.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/runtime.ts>)
- [src/app/sessions.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/sessions.ts>)
- [src/app/store-read.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store-read.ts>)
- [src/app/store.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/store.ts>)
- [src/app/versions.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/versions.ts>)
- [src/executor/background.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/background.ts>)
- [src/executor/dsh.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/executor/dsh.ts>)
- [src/infra/health.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/infra/health.ts>)
- [src/infra/paths.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/infra/paths.ts>)
- [src/kv.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/kv.ts>)

#### interaction（45 文件）

- [src/app/api.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/api.ts>)
- [src/app/cards.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/cards.ts>)
- [src/app/delivery.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/delivery.ts>)
- [src/app/http.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/http.ts>)
- [src/app/notices.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/notices.ts>)
- [src/app/outbox.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/outbox.ts>)
- [src/app/prompts.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/prompts.ts>)
- [src/app/resources.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/resources.ts>)
- [src/app/role-models.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/role-models.ts>)
- [src/app/settings-history.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/settings-history.ts>)
- [src/app/settings.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/settings.ts>)
- [src/app/views/overview.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/overview.ts>)
- [src/app/views/records.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/records.ts>)
- [src/app/views/settings.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/settings.ts>)
- [src/app/views/sources.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/sources.ts>)
- [src/app/views/text.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/text.ts>)
- [src/app/views/threads.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/threads.ts>)
- [src/app/views/tickets.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/views/tickets.ts>)
- [src/client/api.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/api.ts>)
- [src/client/app.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/app.tsx>)
- [src/client/client.css](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/client.css>)
- [src/client/controls.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/controls.tsx>)
- [src/client/css.d.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/css.d.ts>)
- [src/client/deployment.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/deployment.tsx>)
- [src/client/draft.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/draft.tsx>)
- [src/client/eval.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/eval.tsx>)
- [src/client/execution.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/execution.tsx>)
- [src/client/index.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/index.tsx>)
- [src/client/locales.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/locales.ts>)
- [src/client/markdown.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/markdown.ts>)
- [src/client/marks.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/marks.ts>)
- [src/client/overview.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/overview.tsx>)
- [src/client/prompt-config.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/prompt-config.ts>)
- [src/client/prompts.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/prompts.tsx>)
- [src/client/provider.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/provider.tsx>)
- [src/client/route.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/route.ts>)
- [src/client/rows.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/rows.tsx>)
- [src/client/settings-kit.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/settings-kit.tsx>)
- [src/client/settings.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/settings.tsx>)
- [src/client/source.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/source.tsx>)
- [src/client/text.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/text.ts>)
- [src/client/thread.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/thread.tsx>)
- [src/client/ticket.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/ticket.tsx>)
- [src/client/trigger.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/trigger.tsx>)
- [src/client/widgets.tsx](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/client/widgets.tsx>)
#### integration（34 文件）

- [src/app/assessment.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/assessment.ts>)
- [src/app/context.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/context.ts>)
- [src/app/execution-environment.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/execution-environment.ts>)
- [src/app/links.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/links.ts>)
- [src/app/setup.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/setup.ts>)
- [src/app/skill-files.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/skill-files.ts>)
- [src/app/source-context.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/source-context.ts>)
- [src/app/tools/executor.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/tools/executor.ts>)
- [src/app/tools/main.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/tools/main.ts>)
- [src/app/tools/tool.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/app/tools/tool.ts>)
- [src/deployment.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/deployment.ts>)
- [src/index.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/index.ts>)
- [src/infra/commands.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/infra/commands.ts>)
- [src/infra/environment.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/infra/environment.ts>)
- [src/infra/text.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/infra/text.ts>)
- [src/limits.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/limits.ts>)
- [src/navigation.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/navigation.ts>)
- [src/setup.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/setup.ts>)
- [src/sources/admission-context.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/admission-context.ts>)
- [src/sources/feishu-channel.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/feishu-channel.ts>)
- [src/sources/feishu-image.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/feishu-image.ts>)
- [src/sources/feishu-loops.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/feishu-loops.ts>)
- [src/sources/feishu-read.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/feishu-read.ts>)
- [src/sources/feishu-trigger.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/feishu-trigger.ts>)
- [src/sources/feishu.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/feishu.ts>)
- [src/sources/github-channel.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github-channel.ts>)
- [src/sources/github-pull.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github-pull.ts>)
- [src/sources/github-read.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github-read.ts>)
- [src/sources/github-trigger.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github-trigger.ts>)
- [src/sources/github.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/github.ts>)
- [src/sources/host.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/host.ts>)
- [src/sources/kind.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/kind.ts>)
- [src/sources/poll.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/poll.ts>)
- [src/sources/registry.ts](<https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/src/sources/registry.ts>)
