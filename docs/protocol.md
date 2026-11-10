# 协议与运行语义

多 Agent 扩展随 1.4.0 发布；运行判读与 owner 复核处置随 1.5.0 发布，沿用从 PTC 派生的 `xiao-he-runtime`，不新增 team 模式，历史 1.0/0.x 变更不因此重写。

## 工具

| 工具 | 输入 | 返回 |
|---|---|---|
| `runtime_capabilities` | `{}` | 描述当前调用上下文的能力与限制，不执行准入检查、不创建 run |
| `runtime_run` | `{ plan, async? }` | 同步：运行摘要与步骤状态；仅不含 Agent 且调用未携带 `exec.toolSet` 的受控宿主计划可用 `async:true`：受理后立即返回 `{ runId, state:"running" }` |
| `runtime_status` | `{ limit?, offset? }`、`{ snapshot:true, limit? }`、`{ cursor, limit? }` 或 `{ runId }` | 本会话最近运行列表与脱敏存储诊断，或指定运行元数据（不含结果） |
| `runtime_result` | `{ runId }` 或下述分页参数 | 运行摘要 + `acceptance` + 已保存步骤结果（`truncated/bytes` 标记）；分页同样含 `acceptance` |
| `runtime_acknowledge` | `{runId,snapshotHash,key,expectedRevision,reason}` | 原 owner 显式记录当前版本问题已知悉，返回摘要与 `acknowledgementHistory`；不是解决或验收 |
| `runtime_review` | `{runId,snapshotHash,expectedRevision,disposition,reason}` | 记录 owner 处置并返回摘要与 `ownerReviewHistory`；不是独立验收 |
| `runtime_cancel` | `{ runId }` | 发起取消后的运行摘要；不保证 Worker 已清理或宿主操作已实际停止 |
| `runtime_resume` | `{ runId }` | 同步等待恢复结果；仅 `interrupted` 可恢复 |

`runtime_status` 列表 `limit` 为 1–100，默认 20；`offset` 为 0–10000，默认 0。先按所有者过滤，再按更新时间降序分页；同时间以运行 ID 稳定排序。指定 `runId` 时不能同时提供分页参数。所有工具拒绝未知字段。

运行摘要与列表新增派生 `progress`（各步骤状态计数）及 `guidance`（未知副作用、后台 Job 和中断处置提示）。它们仅在会话归属检查后生成，不写入 version 1 记录。建议操作不是授权，不会自动执行 Job、恢复或重发。工具的 JSON 文本返回保留，另提供宿主支持的结构化输出及展示摘要；实际桌面效果需独立验收。

<a id="跨任务待办与历史元数据检索源码新增未发布"></a>

### 跨任务待办与历史元数据检索（1.7.0）

`runtime_query({q?,taskId?,state?,action?,view?,limit?,offset?})` 是只读查询入口，不改变现有 status/task 接口，不注册 Web 面板。归属从当前调用取得，不能传 owner；拒绝未知字段、cursor、snapshot。

| 参数 | 语义 |
|---|---|
| `q` | 可选，原字符串最多 256 UTF-16 code units，trim 后非空；对 goal 及 provenance 的 request_ref、scope_summary、context_refs 做大小写不敏感字面子串匹配，不是正则或语义搜索 |
| `taskId` | 可选，现有任务 ID 格式，精确匹配 |
| `state` | 可选，running/succeeded/failed/cancelled/interrupted |
| `action` | 可选，精确匹配当前派生 action.kind；沿用已有行动类别 |
| `view` | 默认 all；needs_action 为当前 action.actor=owner 且非 review_results；review 为当前 action.kind=review_results，两组互斥，非穷尽所有运行 |
| `limit` / `offset` | 默认 20 / 0；范围 1–100 / 0–1000，整数 |

条件 AND。先按 owner 隔离，合并同根目录的活动/存储失败内存记录，再按 q/taskId/state/action 过滤、计算分组、按 view 过滤，最后按 updatedAt 降序、runId 升序分页。行动复用 runAction，保留未知副作用优先、知悉及决策处置规则；查询不写知悉/决策/复核记录。

返回 `kind:"owner_metadata_query"`、`runs`、`view/offset/limit/hasMore`、`matchedCount`、`groups:{needsAction,review}`、`scope:"retained_owner_runs"`、`order:"updatedAt_desc_runId_asc"`、`observedAt/scannedCount/scanLimit`、diagnostics 与范围说明。matchedCount 为 view 筛选后的运行数；groups 为其他条件筛选后、view 筛选前的互斥运行数，不是事项数，也不是本页计数。runs 只含 runId/state、可选 goal/provenance/taskId/previousRunId、updatedAt/stepCount/action；完整证据须显式 runtime_result 读取。输入、结果、错误、提示词正文不被索引或回显。

候选最多 1000 条；同 owner 可读记录与内存记录合并后超限报 RUNTIME_INVALID_STATE，在任何内容筛选前拒绝，不以近期窗口冒充完整筛选。沿用 RunStore 扫描与严格读取检查，该上限约束候选记录数，不是目录扫描、磁盘读取字节或耗时预算。读取故障报 RUNTIME_STORAGE_FAILED，持续成员变动报 RUNTIME_BUSY；坏格式/超大记录被跳过并体现在 diagnostics，因此计数仅覆盖可读取的保留记录，空结果不证明没有待办。累计诊断不是当前健康判断。

每次查询独立重算；offset 翻页可能因状态变化或新增/清理而重复或遗漏，不提供快照 cursor，不应拼接为一致历史。查询不抓取来源引用、不调用模型或宿主工具、不自动恢复/重试/投递、不扩大授权，不是交付或独立验收结论。

```ts
await tools.runtime_query({view:"needs_action", limit:20});
await tools.runtime_query({view:"review", q:"Atlas"});
await tools.runtime_query({q:"issue:42", taskId:"audit", state:"failed"});
```

<a id="跨-run-显式上下文交接源码新增未发布"></a>

### 跨 run 显式上下文交接（1.7.0）

`runtime_handoff({runId,selections:[{stepId,resultHash}],summary})` 仅读取原 owner 的有 taskId 源运行。源运行须 succeeded/failed/cancelled 且本进程已观察清理收束；活动、清理中、interrupted、存储故障或重启后清理未知均拒绝，不推断外部 Job 已停止。选择 1–8 个不重复的成功步骤，结果须完整保留，resultHash 必须与 value JSON 的 SHA-256 相同。摘要为 owner 自写不可信资料，非空、最多 4096 UTF-8 字节，允许换行/tab，拒绝其他控制字符和非法代理对；总快照有界为 12KiB。不读取任意路径、不从 URL 抓取内容。

返回 `{kind:"untrusted_run_handoff",sourceRunId,taskId,summary,selections,snapshotHash,authorized:false,executable:false}`，不包含结果正文。snapshotHash 绑定固定键序的 kind/sourceRunId/taskId/summary/selections，不证明摘要真实、作者身份、结果已验收或权限。交接工具本身不新建持久记录。

调用者可将快照原样放入新 plan.handoff，必须同时给同 task_id 和指向 sourceRunId 的 previous_run_id。提交与恢复在任何新执行前重验源归属、收束与所选结果哈希；来源被清理、缺失、截断或变更则拒绝，不寻找替代记录。新计划仍受 64KiB、工具准入和 Worker 门禁约束，不跳过任何新步骤。

快照随后继 plan 保存，仅完整 runtime_result 返回 handoff；状态、列表、任务卡不暴露摘要正文。资料不自动追加给 Worker 或普通工具；Lead 必须显式组织下一份任务 prompt，不能把摘要当指令或授权。没有跨 run 任意结果读取器，不向活 Worker 推送消息，不自动执行/恢复/重试。重启后源清理观察未知会阻止使用该交接恢复，不提供自动绕过。

```ts
const page = await tools.runtime_result({runId: sourceRunId, stepId: "inspect"});
// 先按需读完结果并核实，再写交接摘要。
const handoff = await tools.runtime_handoff({
  runId: sourceRunId,
  selections: [{stepId: "inspect", resultHash: page.page.hash}],
  summary: "已核对的事实与未解决事项；不构成执行授权",
});
await tools.runtime_run({plan: {
  task_id: handoff.taskId, previous_run_id: handoff.sourceRunId, handoff,
  steps: [{id: "next", tool: "read", input: {file_path: "README.md"}}],
}}); // 新步骤照常执行；交接摘要不会自动变成步骤输入。
```

<a id="决策处置关联源码新增未发布"></a>

### 决策处置关联（1.7.0）

`runtime_decision({runId,snapshotHash,key,expectedRevision,disposition,reason,answer_ref?,successor_run_id?})` 只记录原 owner 的决策处置，返回运行摘要及 `decisionHistory`。不同于 `runtime_acknowledge` 的“已知悉”和 `runtime_review` 的结果复核。

- 先读报告和证据，再从当前摘要取得 `attention.snapshotHash`、`decision_required` 项的 key，以及 `decisionLedger.revision`（不是 attention.revision）。陈旧快照或 revision 拒绝。
- disposition 为 answered（已记录答复，必须提供 answer_ref）、superseded（被替代）或 dismissed（不再处理）。reason 为非空、最多 2048 UTF-8 字节；answer_ref 为非空、最多 1000 UTF-16 单元的不透明引用，不抓取或验证引用内容。新文本拒绝控制字符。
- 仅源运行已结束并收束的 succeeded/failed/cancelled 可记录；活动、清理中、interrupted 或存储故障运行拒绝。只允许当前真实 decision_required 项，每 run 最多 32 条，追加历史不覆盖旧记录；与复核/知悉共用记录写锁。
- 可选 successor_run_id 必须已存在、不同于源 run、同 owner、同非空 taskId，且其 previousRunId 指向源 run。它可以尚在运行；关联不创建、恢复、授权或确认后继执行成功。后继日后可能被清理，历史引用不保证永久可读。
- 单 run 与列表摘要新增 `decisionLedger:{revision,verification:"owner_declared_not_user_approval",items:[{key,stepId?,resultHash?,status,recordedAt?}]}`，status 为 open 或上述 disposition。摘要不包含理由、答复引用或后继引用。完整和分页 runtime_result 均返回 decisionHistory，记录字段为 revision/snapshotHash/key/disposition/reason/answerRef?/successorRunId?/at。
- 当前版本已处置的决策请求仍保留在 attention 中并标 disposition，不再计入该项默认提醒、下一步决策行动或任务页待办。未知副作用、失败、结果缺失和结果复核仍各自保留；处置不会自动知悉或复核其他事项。问题快照变化后旧处置不再生效，重新显示 open，旧历史仍保留。
- 留痕不改变执行状态、时间戳、原始结果或权限；不证明用户批准、真实答复存在、问题解决、交付或独立验收。不向活 Worker 发消息，不自动执行、恢复、重试、投递通知或停止 Job。

```ts
const saved = await tools.runtime_result({runId});
// 先核实完整报告与证据，必要时继续分页读取。
const question = saved.attention.items.find(item => item.kind === "decision_required");
if (question) {
  await tools.runtime_decision({
    runId, snapshotHash: saved.attention.snapshotHash, key: question.key,
    expectedRevision: saved.decisionLedger.revision,
    disposition: "answered", reason: "记录已核对的答复出处；不代表授权执行",
    answer_ref: "session:已核对的答复事件引用",
    // successor_run_id: 已由owner另行提交、previousRunId指向本run的后继ID
  });
}
```

<a id="计划差异摘要源码新增未发布"></a>

### 计划差异摘要（1.7.0）

仅完整 `runtime_result({runId})` 返回 `planComparison`；不新增模型工具或输入参数。列表、task、status、run/review/cancel/resume 摘要及 stepId 结果分页不计算差异，避免列表逐条读取前驱。

- 可比较：`{comparable:true,changes:{addedSteps,removedSteps,changedSteps,concurrencyChanged,goalChanged,provenanceChanged,handoffChanged}}`。按显式 previousRunId 读取同 owner、同 task 且已终态收束的前驱，不自动寻找别的历史。步骤 ID 排序；changedSteps 为 `[{id,fields}]`，fields 仅包含 tool/input/dependsOn/retry/timeoutMs，不输出输入正文、前后值、字段路径或哈希。目标、来源说明与交接快照只报变化布尔值，不展示交接正文或哈希。
- 忽略对象键顺序、步骤列表顺序和依赖集合顺序；输入数组仍区分顺序。步骤改名算删除加新增，不推测重命名。task/previousRunId 是关联，不列为计划内容变化。
- 不可比较：`{comparable:false,reason}`，无 changes。reason 为 no_previous_run（未关联前驱）、predecessor_unavailable（缺失、不可读、记录/schema 不可用或不属于 owner，统一处理避免泄漏）、incompatible_predecessor（任务/状态不兼容或前驱仍占活动槽）。不可比较不等于无变化；仅 comparable:true 且所有变化列表为空、布尔值为 false 才表示所列字段无变化。
- 比较只派生详情，不写入运行记录，不复用结果、不执行或恢复、不授予权限；差异小或无变化不证明行为等价、安全、交付或验收。返回的是当前仍保留的前驱记录比较，不是不可篡改历史。模型预算等待诊断本次不实现。

### 能力说明

`runtime_capabilities({})` 返回 `ordinaryDag:"supported"`、`worker:"conditional"|"unavailable"`、`workerReason`、`ordinaryAsync:boolean`、`workerAsync:false`、`workerTools`、`limits`、`authorization:"checked_at_execution"` 和说明 `message`。普通 DAG 每次执行仍由宿主准入；这不是查询授权、资源保留或真实工具/模型可用性探测。

仅可信 `DelegationPolicyAdapter` 存在且父 `exec.toolSet` 存在时 Worker 标为 `conditional`，表示仍需执行期检查；否则为 `unavailable`。对应 `workerReason` 为 `trusted_adapter_missing`、`parent_admission_missing` 或 `execution_checks_required`。标准插件入口未接入适配器，不能据此声称 Worker 门禁已修复。`ordinaryAsync` 仅在无 `toolSet` 时为 true；Worker 异步始终不可用，不得删除父准入集合绕过限制。

<a id="共享容量观察源码新增未发布"></a>

### 共享容量观察（1.7.0）

能力返回新增 `capacity:{scope:"module_process_root",observedAt,capacityBusy:boolean}`。观察范围为当前模块实例、进程及规范化运行根目录，不是全宿主或跨进程统计；`observedAt` 为毫秒时间戳。capacityBusy 只表示共享活动运行数已达运行上限（含终态但尚未收束的占槽），不检查 Worker 是否满载或可用、宿主工具是否仍存活。普通 owner 只得到此粗化布尔值，不返回其他 owner、运行/任务标识、目录或精确占槽数。false 不保证未来有空槽、授权通过或调用成功；查询不做预留、排队或自动重试，勿轮询正在同步等待的运行。

包入口额外导出 `CapacitySnapshot` 类型；可信宿主可调用已持有服务的 `service.capacity()`：

```ts
const load = service.capacity();
// { scope: "module_process_root", observedAt,
//   occupiedRuns, executingRuns, cleanupRuns, runLimit,
//   workersInUse, workerLimit }
```

- occupiedRuns 是共享 manager 的活动占槽数；executingRuns 是其中 running 或已准入但尚处于 interrupted 的恢复初始化窗口数量（不证明工具已启动）；cleanupRuns 是终态但执行 Promise 尚未收束的数量，满足 occupiedRuns = executingRuns + cleanupRuns。它不是“清理出错数”，也不确认清理成功。
- workersInUse 包含 Worker 创建、执行和等待清理；workerLimit 仅为上限，不是 Worker 可用性或授权声明。
- 宿主方法仅读内存，不读写运行记录、不调用父策略、不注册任何模型工具。返回新对象，修改快照不影响准入。宿主自行控制精确聚合的可见权限，不得直接向普通 owner 暴露跨 owner 数量。服务开始 dispose 后拒绝查询；不保留历史快照。
- 运行槽释放不证明普通工具/后台 Job 已退出，零占槽也不证明外部工作停止；未知副作用边界和原来的 fail-fast 准入不变。本项不引入分类限流、持久队列、自动恢复或 Worker 门禁放宽。

### 恢复摘要

单 run 的 run/status/result/cancel/resume 摘要增加以下派生字段；异步受理回执仍为 `{runId,state:"running"}`，不是完整摘要。

```ts
recovery: {
  resultCertainty: "recorded" | "incomplete" | "unknown";
  cleanup: "pending" | "settled" | "unknown";
  externalWork: "unconfirmed";
  nextAction: "wait" | "inspect_external_state" | "resume_read_only" | "review_results" | "inspect_failure";
  message: string;
}
```

`resultCertainty` 区分记录已保存、不完整或存在未知状态，不评价证据正确性或任务是否通过。`cleanup` 仅观察本进程调度/owned Worker 的清理收束；缺少本进程观察时为 unknown，settled 不证明清理成功或外部工具/Job 停止。`externalWork` 始终未确认。`nextAction/message` 仅为判读建议，不自动等待、恢复、重发或授予新权限；具体异常处置见[运行状态与故障处置](<OPERATIONS.md>)。

### 待处理事项与等待原因

完整运行摘要与 status 列表项增加可选派生字段（异步受理回执不变）：

- `attention.items`：按外部状态核验、失败检查/中断只读恢复处置（resume_read_only）、Worker 待决、结果缺失/截断、结果复核排序的事项。每项含 `key/kind`，可带 `stepId/resultHash`；不回显问题或报告自由文本。决策请求仍为 Worker 自报，原报告通过 result 读取，不是权限或自动暂停条件。
- `attention.notification:{key,shouldNotify}`：键只覆盖必须处理事项（外部状态未知、失败、只读恢复、Worker 待决、结果缺失/截断），稳定 SHA-256；`review_results` 仍在 `items`，但不进入键，也不使 shouldNotify=true。无必须处理事项时 shouldNotify=false。更新时间、尝试次数不单独触发新键；键供上层合并提醒，不表示已发送、已读、已忽略或已处理。读取不确认事项，不持久化通知收据；只有显式 runtime_acknowledge 才保存问题知悉记录。
- `waiting:{steps,cleanupPending}`：仅 running 的 pending 步骤列出 dependency（依赖未成功）、scheduler（依赖已满足，等待调度槽或后续批次）或 retry_backoff（当前进程实际处于只读重试退避）。仅真实退避观察附 waitingSince、nextRetryAt（毫秒时间戳）、枚举 retryCategory，以及可选 disposition：`waiting_retry`（transient/legacy_unknown，本次失败按既有策略等待重试，未升级）或 `needs_action`（其他类别，重试条件不成立）。不从错误正文推断，不因此放宽 retry。nextRetryAt 不是执行保证。

退避观察仅存在于当前进程、当前 RunRecord，不写入 v1 记录，重启后不推断历史等待时间。cleanupPending 仅表示已知本进程运行 Promise 在终态后尚未收束，不证明外部工作停止。当前无容量等待队列，不展示虚构 capacity 等待。

展示卡默认只展开必须处理事项；`review_results` 和常规进度留在详情。当前页列表只汇总各类事项计数，必须处理优先且保持分组内顺序；不同运行不折叠，每个 runId、状态、结果读取入口与 Job 提示分别保留。所有待办均提供只读 runtime_result 定位，待决步骤沿用该步骤结果哈希，其他事项不把聚合哈希用作分页哈希。恢复前须检查原始提交计划与步骤状态；owner 复核不是回答 Worker 并续跑的接口。上层可用 notification.key 合并提醒，也可在自己的界面忽略该键；问题知悉记录另见下节，查询不会确认或清除事项。旧返回值没有这些字段时仍使用原展示。不改变状态/依赖成功条件、不自动执行恢复、不给副作用步骤增加重试、不新增独立验收或工单，不自动接入外部渠道；显式宿主投递适配与通知回执协议见下节；owner处置另见下节；列表只聚合当前页的本会话运行，不是全量全局待办。

<a id="行动摘要任务视图与通知回执源码新增"></a>

### 行动摘要、任务视图与通知回执（1.7.0）

以下能力自 1.7.0 提供；1.6.0 历史产物不变。

**行动摘要。** 单run摘要与status列表新增 `action:{kind,actor,message}`，纯派生、不写回运行。优先级：未知外部副作用 → 清理在途 → 未知悉失败/待决/结果缺失/只读恢复 → 结果复核 → 重试退避/运行中 → 无未知悉待办的调度终态。actor为owner/runtime/none；settled不是问题解决、交付或验收，清理未知仍提示。

**任务视图。** `runtime_task({taskId,limit?,offset?})` 仅查询当前owner同taskId保留运行，taskId与计划规则相同，分页默认20/0，范围1–100/0–10000。先筛选owner/task再分页，按updatedAt降序、runId升序。返回runs（含previousRunId/action/attention/ownerReview，无原始结果）、offset/limit/hasMore、scope=retained_owner_runs、order、page及diagnostics。page包含runCount/activeCount/attentionCount/reviewCount，仅本页计数；attentionCount为未知悉事项数（未知副作用知悉后仍计入），reviewCount为待复核运行数。历史可能已清理，前驱可能不在本页；结果按runId另行读取，不推断业务交付。查询不创建回执。

**成员快照分页（1.7.0 新增）。** `runtime_status` 列表与 `runtime_task` 在旧 offset 分页之外支持以下两种互斥输入，limit 均为 1–100、默认 20：

| 查询 | 首屏 | 续页 |
|---|---|---|
| status 列表 | `{snapshot:true,limit?}` | `{cursor:<nextCursor>,limit?}` |
| task 视图 | `{taskId,snapshot:true,limit?}` | `{taskId,cursor:<nextCursor>,limit?}` |

- snapshot/cursor 与 offset 互斥，cursor 与 snapshot 互斥；snapshot 只接受 true。status 的 runId 模式不接受 snapshot/cursor 或其他分页参数。cursor 绑定当前 owner 及查询范围，task 续页必须保留同一 taskId，不可跨 owner、跨 task 或与 status 列表混用。
- 捕获时以 `updatedAt_desc_runId_asc` 排序，仅固定当时保留运行的成员 ID 与顺序，不冻结运行状态。每页重读 owner 记录，新增运行不插队，后续状态更新不重排成员；清理或不可读的成员在该页 `pagination.missingRunIds` 显式列出，不补位。
- 返回 `order:"snapshot_membership"` 与 `pagination:{mode:"snapshot",capturedAt,expiresAt,total,missingRunIds,nextCursor?}`；时间为毫秒时间戳，total 是捕获时成员总数，nextCursor 仅有下一页时提供。offset/limit/hasMore 描述固定成员窗口，runs 与 page 计数只含本页实际可读记录，不能因缺失而补取后续成员。
- 快照只在当前 RuntimeService 实例内保存，有效期 5 分钟；每实例最多 16 份，容量满时淘汰最早快照。每份最多 1000 ID，超过单份上限拒绝（`RUNTIME_INVALID_STATE`），不静默截断。过期、重启、服务销毁或淘汰后 cursor 报 `RUNTIME_NOT_FOUND`，需重新 `snapshot:true`。不持久化、不承诺全量历史，也不要与持续变动的 offset 活动页直接拼接。旧 offset 分页语义与默认值保持不变。

```ts
const first = await tools.runtime_task({taskId:"audit", snapshot:true, limit:10});
if (first.pagination.nextCursor) {
  const next = await tools.runtime_task({taskId:"audit", cursor:first.pagination.nextCursor, limit:10});
  console.log(next.runs, next.pagination.missingRunIds);
}
```

**宿主显式投递。** 包入口导出 RuntimeService 与 NotificationSender 类型。受控宿主用原 owner 的执行上下文调用 `service.deliverNotification(runId, ownerExec, sender)`，不注册新的模型工具，也不自动触发发送。方法对当前 pending 回执执行 sync → claim → 再校验 → sender → settle，正文仅含固定行动说明、runId 与结果读取入口，不含原始结果、输入、owner 身份或 token。messageId 按 runId 与通知 key 派生；渠道及授权由宿主绑定，sender 必须持久化并按该 ID 去重。sender 返回 sent 才登记 sent，明确 not_sent 登记 failed；unknown、非法返回或异常保留 delivering。重复调用跳过 sent/failed/delivering，不隐式重试。取消或存储失败可能发生在发送之后，须核验渠道，不可盲目重发；旧快照回调不能覆盖新状态。宿主须等待此 Promise 并在关闭前取消其 signal；不创建计时器、后台任务或调用 DAG。标准插件没有默认渠道，真实渠道送达仍须集成验收。

**通知回执。** `runtime_notification` 只管理投递状态，不接外部渠道。get默认只读，返回runId/current/可选receipt/verification/message；current.shouldNotify来自当前attention.notification，current.key额外绑定attention.snapshotHash作为投递版本（不要直接使用attention.notification.key）；同类问题的新快照不会被旧sent/withdrawn压住。receipt可能是未sync的旧版本。verification固定owner_declared_not_delivery_verified。

| operation | 额外参数 | 行为 |
|---|---|---|
| get（默认） | 无 | 只读，不入队 |
| sync | 无 | 需要提醒时创建pending；同key不重置，新key替换旧内容并递增revision；无需提醒时撤回未发送记录，已sent保留 |
| claim | key、expectedRevision | 当前pending/failed变为delivering，递增revision/attempts并返回attemptToken，不是执行授权 |
| settle | key、expectedRevision、attemptToken、outcome=sent或failed | 精确匹配当前版本与尝试，登记结果、递增revision并清token，不是网络凭证 |

claim/settle前重新对齐当前事项；撤回、新key或陈旧revision/token拒绝。回执含runId/key/revision/status/attempts/updatedAt及仅delivering可有的attemptToken。卡片仅展示状态和revision，不展示token或正文。回执独立存于运行目录notifications子目录，文件名是owner+runId哈希，锁内CAS、原子替换、有界严格读取，损坏或锁忙失败关闭。不修改v1运行/执行时间，不代替问题知悉。回执不会随run自动清理；run删除后API不再可访问，清理整个运行目录应包含子目录，不将其作为永久审计账本。

显式调用顺序：

```ts
const queued = await tools.runtime_notification({runId, operation:"sync"});
// 仅current.shouldNotify且receipt.status为pending/failed时领取。
const claimed = await tools.runtime_notification({runId, operation:"claim", key:queued.receipt.key, expectedRevision:queued.receipt.revision});
// 宿主自行配置、授权渠道并显式投递；本工具不发送。
// 获得明确结果后，用claimed.receipt的新revision与token登记sent/failed。
```

sent仅投递方声明，不证明实际送达、阅读、处理、交付或验收。失败重试须显式重新claim，无后台发送或轮询。崩溃遗留delivering不超时回收，不自动重发；先核验渠道，确认后用原token登记。新key可替换旧投递，但不能撤销已发生的发送，不保证exactly-once。未知外部副作用不会因sent消音。

### 问题已知悉（1.6.0）

原 owner 可显式调用 `runtime_acknowledge`（参数见工具表），snapshotHash、expectedRevision、key 分别复制当前 attention.snapshotHash、revision、items[].key。只允许 succeeded/failed/cancelled 的持久化运行；running/interrupted、活动或清理在途及易失失败记录拒绝。review_results 不可知悉，应使用 runtime_review。理由非空且最多2048 UTF-8字节，每run最多32条，不驱逐历史。

知悉后该事项仍在 items 并带 acknowledged:true，卡片仍展开且注明“不等于解决或验收”；普通问题不再使 notification.shouldNotify=true，inspect_external_state 即使已知悉仍保留提醒。快照绑定计划、运行/步骤状态、尝试次数、错误、结果及步骤时间；这些内容变化使旧记录失效，同键新问题也不会被压住。snapshotHash 不是结果分页 hash，也不是已阅读证据。

记录存于 v1 的可选 acknowledgements，revision 全run递增；acknowledge 和 result（含分页）返回 acknowledgementHistory，理由不进入 status 列表或展示元数据。随run既有保留策略清理，不是永久账本。写入与 review/remove 共用 .review-lock，在锁内重新检查 owner、快照和revision，沿用原子保存；锁忙拒绝，旧版本不认识新字段，不能混用记录目录。

知悉不改变执行状态/时间、结果、验收、权限或恢复规则，不回答Worker，不发送通知，不重试或停止Job，也不表示问题已解决。首版不提供“已解决”。

### Owner 复核处置

摘要与列表提供 `ownerReview`：revision、status（not_recorded/stale/accepted/needs_work）、可选 snapshotHash/recordedAt；verification 固定为 owner_declared_not_independently_verified。result（含分页）和 review 返回 ownerReviewHistory，理由仅在这两个 owner 专属结果中返回，不进入展示元数据或列表。

读取全部结果与证据后，调用 `runtime_review({runId,snapshotHash,expectedRevision,disposition,reason})`。hash/revision 从当前 ownerReview 读取；disposition 为 accepted 或 needs_work，理由非空且最多2048 UTF-8字节。快照绑定 runId、归一化计划、步骤工具/状态/尝试次数和每项完整 value JSON SHA-256；计划或结果变化使旧处置 stale。hash不证明读取或证据真实性。

首版只允许非活动、成功且全部结果完整的持久化运行，拒绝清理在途、失败、取消、中断、缺失/截断和易失存储失败记录。所属会话取自宿主 exec.agent.id，参数不能声明 reviewer/人工身份；Worker 与普通 DAG 步骤均不开放此工具。owner调用者可能也是模型，accepted只代表该会话声明，不是独立验收、人工批准或后续执行授权；acceptance.status仍为not_reviewed。仅匹配当前快照的accepted收敛review_results提醒，needs_work/stale保留；未知副作用、失败和待决问题不因此消失，不自动重跑。

记录存于 version 1 run 的可选 ownerReviews，最多32条，超限拒写而不驱逐。记录不改变运行时间、状态和保留排序，随终态运行一起按既有策略清理，不是永久审计库；旧版读取器不认识此字段，使用处置后的记录目录不能交给旧版写入。坏记录继续严格拒读，不默认为未处置。

写入使用每run排他 `.review-lock`，在锁内重新读取并检查owner/hash/revision，陈旧值报RUNTIME_RESULT_CHANGED，锁忙报RUNTIME_BUSY。运行删除/保留清理也遵守该锁（锁忙跳过删除）。锁内沿用临时文件/fsync/rename；失败不先更新内存。崩溃遗留锁不会自动抢占，应先停掉所有访问该目录的宿主、备份运行记录并核验结果，再由操作者移除对应锁；不要在线清锁。此互斥仅覆盖新版本的review/acknowledge/remove，不为外部文件修改或旧版写入提供事务保证，不承诺掉电绝不回退。

## 计划（plan）

`plan = { goal?, task_id?, previous_run_id?, provenance?, handoff?, concurrency?, steps[] }`；`step = { id, tool, input, depends_on?, retry?, timeout_ms? }`。

- 允许步骤：`read/glob/grep/edit/write/pwsh/agent`；`retry` 只允许 `read/glob/grep`（0–3）。依据结构化类别/代码判定重试；确定性权限、参数、资源不存在等错误不重试，已知瞬态可重试。无结构化信息的未知错误保留旧重试行为，不解析错误正文。退避为 100/200/400ms，等待可取消；超时不自动重试，避免上次调用未实际停止时发生重叠。宿主未保留的原始错误字段不可凭空恢复，宿主 canonical error.info 之外的信息不作为分类依据。
- 约束：1–32 步；计划 ≤64KiB；并发 1–4；单步超时 1s–600s；`id` 唯一、依赖必须存在、禁止环。
- `depends_on` 表示成功后的执行顺序；仅 `agent` 将直接依赖结果追加到 prompt，其他工具输入不插值。普通工具输入按宿主工具自身 schema、父调用权限和工作目录执行。
- 1.7.0 新增：整份计划仅含 `read/glob/grep` 时采用完成驱动调度，步骤成功且结果落盘后，有空槽即派发依赖已满足的步骤，不等待其他在途步骤；并发仍为 1–4。重试退避继续占用该步骤的槽位，不能重复派发；超时不补槽继续执行，失败/unknown、取消或存储故障停止新派发，在途调用仍按既有规则收束，不证明底层宿主调用已经退出。
- 含任意 `agent/edit/write/pwsh` 的整份计划仍为有界批次：一批结束后才启动下一批，即使当前批次只有只读工具也不切换调度。只读 Agent 可与 `read/glob/grep/agent` 同批并行，但不能与本 run 的 `edit/write/pwsh` 同批；不锁跨 run 或外部写入。任一步失败后不再调度新批次；同批已开始的操作不保证回滚。
- 同一进程、同一规范化记录目录分别共享最多 8 个活跃运行和 8 个 Worker；新建和恢复共用 run 配额。Worker 在 agents.create 前同步占槽，创建、执行和清理全部计数，executeAgent（含 dispose）结束后才释放。满载步骤失败 `RUNTIME_AGENT_CAPACITY_EXCEEDED`，不隐式排队、不自动重试；其他 root 或进程不共用。
- `task_id` 为字母开头、可含字母/数字/_- 的 1–64 字符标识。`previous_run_id` 要求同时提供 task_id；前驱必须仍可读取、同 owner、同 task，已处于 succeeded/failed/cancelled 且没有活动清理，才可创建新 run。归属不匹配/缺失报 RUNTIME_NOT_FOUND；task 或状态不符报 RUNTIME_TASK_LINK_INVALID。关联仅为历史，不复用结果、不扩展权限、不替代 resume；保留策略不因关联变化。摘要和列表以可选 taskId/previousRunId 投影，旧记录可缺省。

<a id="计划来源说明源码新增"></a>

### 计划来源说明（1.7.0）

1.7.0 新增的 `plan.provenance` 为可选说明对象：`{request_ref?:string,scope_summary?:string,context_refs?:string[]}`，至少提供一个字段，未知键拒绝。request_ref 上限 1000、scope_summary 上限 2000、每条 context_refs 上限 1000 个 UTF-16 code units；长度按原字符串检查，文本 trim 后必须非空并以 trim 后值存储。context_refs 若提供必须有 1–8 条，空数组拒绝；整个计划仍受 64KiB 上限约束。

这些信息仅说明请求来源、范围与上下文引用，不代表身份核实、权限、批准或验收；不自动抓取引用内容，也不作为 Worker 指令或注入 Worker prompt。随计划按 owner 隔离存储，run/task 卡将来源信息与状态/行动等分栏显示；字段缺失显示“未提供”，不从 goal、任务关联或旧记录猜测补全。

```json
{
  "plan": {
    "task_id": "audit",
    "provenance": {
      "request_ref": "本轮用户请求",
      "scope_summary": "仅只读检查 README",
      "context_refs": ["用户提供的范围说明"]
    },
    "steps": [{"id":"readme","tool":"read","input":{"file_path":"README.md"}}]
  }
}
```

## 结果分页与清理观察

`runtime_result({runId})` 保持完整结果读取；新增 `{runId,stepId,offset?,limit?,hash?}` 仅由原 owner 分页读取指定步骤已保存的 JSON 文本。offset 按 Unicode 码点计，默认 0；limit 默认 2048、范围 1–4096。返回 `results:{}` 与 `page:{stepId,encoding:"json",unit:"unicode_code_point",hash,offset,total,text,nextOffset?}`；按 nextOffset 读完后拼接 text 再 JSON.parse。hash 为完整 JSON 文本 SHA-256，可带入后页防混版本；不匹配报 `RUNTIME_RESULT_CHANGED`。没有 stepId 时不接受分页参数；无可用 value 或已截断报 `RUNTIME_RESULT_UNAVAILABLE`，不会恢复已丢弃内容。不改变 Worker 工具白名单、依赖注入或 64KiB 上限；这不是 Worker lazy-resource 能力。

摘要可选 `executionSettled`：false 表示本进程运行 Promise 尚未收束（终态后可能还在清理），true 表示调度及 owned Worker 清理 Promise 已收束，不表示清理必定成功或普通宿主工具/Job 已退出。此观察仅存在于本进程、有界保留，不写入 v1 记录；缺省为未知，重启后不能据历史记录推断清理完成。`finished` 仍仅表示调度终态。

### 待复核结果汇总

`runtime_result` 完整与分页返回均增加：

```ts
acceptance: {
  status: "not_reviewed";
  workers: {
    stepId: string;
    state: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
    resultHash?: string;
    reportOutcome?: "completed" | "partial" | "blocked";
    criteria?: { observed: number; notVerified: number; blocked: number };
    evidenceCount?: number;
    limitationCount?: number;
    decisionRequired?: boolean;
  }[];
}
```

`resultHash` 是步骤已保存 `value` 的 `JSON.stringify(value)` 文本（UTF-8）的 SHA-256，与该步骤分页 `page.hash` 一致；绑定输出版本，不是证据核实或验收。缺失、截断等不可取得 value 的情况不能凭哈希恢复原文；可选报告字段缺省不等于报告通过。汇总只投影状态、枚举、布尔值和计数，不回显 summary、note、limitations、requestedDecision 等报告自由文本或 evidence 正文；原始报告与证据仍通过 `runtime_result` 的保存结果或分页读取。`runtime_status` 不含 report 内容，也不提供这份 acceptance 汇总。

`status` 固定为 `not_reviewed`，没有持久化的独立验收记录，不提供 Worker 自授 `accepted`；`observed` 和 `reportOutcome:"completed"` 仍仅是 Worker 自报。Lead 的独立复核仍在上层，无 Worker 时 `workers:[]` 也不证明任务通过。本轮仅增加派生说明，不改变调度/恢复权限，不新增数据库、outbox 或工单系统。

## Agent 步骤（受控宿主集成）

> **当前安全兼容边界：**标准 DSH 0.2.2-rc.1 没有“仅补查父级缺失策略且去重公共层”的公开接口。本插件入口未接入可信 `DelegationPolicyAdapter`，含 `agent` 的 run/resume 在执行前以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 拒绝；普通工具 DAG 不受影响。下述 Worker 执行能力仅适用于显式注入该适配器的受控宿主集成，测试适配器不是 rc.1 通用实现。不能通过删父策略、回放完整父链或修改已安装宿主绕过此门禁。

```json
{
  "goal": "两路只读核查后汇总证据",
  "concurrency": 2,
  "steps": [
    { "id": "api", "tool": "agent", "input": { "prompt": "只读核查 API 边界，列出文件与行号" } },
    { "id": "tests", "tool": "agent", "input": { "prompt": "只读核查已有测试，不宣称未运行测试通过", "access": "read", "max_steps": 12 } },
    { "id": "summary", "tool": "agent", "input": { "prompt": "依据上游资料汇总待 Lead 核实的证据" }, "depends_on": ["api", "tests"] }
  ]
}
```

- `input = { prompt, access?:"read", max_steps?, output_format?:"text"|"report" }`：`output_format` 省略保留旧 `text` 行为；显式值仅接受 `text/report`。prompt 必须是非空字符串；`access` 默认 `read`，`max_steps` 为 1–32 的整数、默认 12。未知字段、`access:"write"` 与非空 `write_scopes` 拒绝；`write_scopes:[]` 仅作兼容归一化，不授予写权限。Agent 不允许非零 `retry`，也不自动重放。
- 含 `agent` 的计划以 `async:true` 或 service `background=true` 提交时，在创建 run/Worker 前以 `RUNTIME_AGENT_ASYNC_UNSUPPORTED` 预检拒绝。父 `exec.toolSet` 在外层工具批次返回时 dispose，不能安全 detach Worker，也不能合成更宽权限代替原 admission。普通工具计划若携带 `exec.toolSet`，异步或 service 后台提交也在创建 run 前以 `RUNTIME_ASYNC_ADMISSION_UNSUPPORTED` 拒绝；宿主批次结束会销毁该准入集合，没有公开续租接口。不得删除准入集合或重新解析以绕过限制；请使用同步调用。
- Lead 仍在 PTC 中编排；公开 `agents.create` 与 `agentPresets.composeFrom` 创建独立上下文 Worker，继承模型路由，强制使用 `NativeToolExecutor`，不是 PTC Worker。宿主 `sandbox:read-only`、`approval:never` 与 `tools.guard` 同时约束，仅允许 `read/glob/grep`，且不能放宽父调用 admission identity 的准入。禁止 `run_code`、命令、写入及递归委派；提示词不是权限控制。
- 工具白名单包含 Worker 实际继承的 preset 作用域工具，并继续核对父 admission identity。Worker 的原生管线检查其 global/preset/local 策略一次；可信宿主适配器只补查父级缺失策略（含局部 hooks/guards），不得再次执行公共层。补查监听以全局可见性（`{global:true}`）注册在 Worker 子上下文、随 Worker 清理注销，子作用域后注册并直接返回 allow、不调用 `next()` 的监听不能跳过它；没有补查证据时最终 guard 拒绝。适配器的 `deny/ask/cancel`、异常及非 allow 返回均拒绝调用，不弹审批。适配器仅由宿主通过 `RuntimeService` 第三个构造参数或 `executeAgent` 第七参数注入，不接受模型 input；缺省拒绝创建 Worker。
- 仅把直接依赖的已保存结果按 `{id,result}` 数组序列化为不可信 JSON，追加至 Agent prompt，不是新指令或授权。无结果 value 或结果截断以 `RUNTIME_AGENT_DEPENDENCY_UNAVAILABLE` 拒绝；追加后 prompt >64KiB 以 `RUNTIME_AGENT_CONTEXT_TOO_LARGE` 拒绝。不会向其他工具插值结果。
- `whenIdle` 后检查 `turn/end` 和最终 assistant 文本；未正常结束或无最终文本不作为成功。子会话 ID 写入 checkpoint 并在运行摘要可见；运行时 `results[step].value` 在所有模式下均为 `{sessionId, output, verification:"not_independently_verified"}`，report 模式另含解析后的 `report`，原始 `output` 不被替换；追溯通过 `steps[].workerTrace` 暴露，不内嵌于结果 value；验收状态保持未验证。`succeeded` 只表示执行结束，不证明结论正确、测试通过或任务已验收；Lead 负责核实。
- 取消/超时传播至 Worker，同步 run 的执行等待其 dispose 后才释放调度槽；服务 dispose 同步发起所属运行的取消并落终态检查点，再等待其清理（即使调用方不等待返回的 Promise，取消也已发起）。`runtime_cancel` 仅发起取消，不等待清理，其返回不是 Worker 已清理的证明。恢复遇到未知 Agent 时失败整个 run，不自动重发。真实模型、桌面 UI 与实际 OS 沙箱仍未验收。

### 结构化报告与追溯

可选 `input.acceptance_criteria:[{id,description}]` 仅允许 report 模式，1–16 项；ID 为字母开头、可含字母/数字/_- 的 1–64 字符且唯一，description 非空白且 ≤1024 UTF-16 code units。对象拒绝未知字段。启用后报告必须增加 `criteria:[{id,status,evidence_indices,note}]`，每个契约 ID 恰好出现一次且无未知 ID；status 仅 `observed/not_verified/blocked`，note 非空白 ≤1024，evidence_indices 为指向 evidence 的非负安全整数索引数组。所有内容仍受整份 16KiB 限制，observed 不代表独立验收通过。不提供契约时不接受凭空 criteria，旧报告形状保持兼容。运行时将契约作为带边界的资料交给 Worker，promptHash 包含实际角色/报告/逐项契约说明；taskPromptHash 仍绑定精确任务 prompt。

仅 `input.output_format:"report"` 启用严格报告解析；Worker 必须返回一个纯 JSON object，不接受 Markdown fence、前后说明、数组或其他 JSON 类型。契约如下（`?` 表示可选字段）：

```ts
{
  outcome: "completed" | "partial" | "blocked";
  summary: string;
  evidence: { path: string; lineStart?: number; lineEnd?: number; revision?: string }[];
  limitations: string[];
  requestedDecision?: string;
}
```

- 整份原始报告（含空白）UTF-8 ≤16KiB；超过报 `RUNTIME_AGENT_REPORT_TOO_LARGE`。JSON 解析或结构无效报 `RUNTIME_AGENT_REPORT_INVALID`。
- 字符串按 JavaScript UTF-16 code unit 计数，均须非空白：`summary` ≤4096、`path` ≤2048、`revision` ≤256、`requestedDecision` ≤2048；`evidence` ≤32 项，`limitations` ≤32 项且每项 ≤1024。
- `lineStart` 为正安全整数；`lineEnd` 也须为正安全整数，要求已有 `lineStart` 且不小于它。顶层和 evidence 对象均拒绝未知字段，包括 `verified`。
- `completed` 至少有一条 evidence 且禁止 `requestedDecision`；`partial/blocked` 至少有一条 limitation。所有状态均必须提供 `evidence/limitations` 数组，但允许的空数组按上述状态条件判定。
- evidence 是 Worker 自报的定位，解析器不解析路径、不打开文件、不核实行号或 revision；报告不会产生授权或独立验收。运行时不按 `outcome` 改写 DAG success 条件：正常结束且格式合格即执行成功，即使 `partial/blocked` 仍可放行依赖。下游仅代表执行顺序，不代表验收后自动写；Lead 应核实后另行决定修改，不能把报告视为自动写入授权。

所有模式均由步骤 `StepRecord` 与摘要的可选 `workerTrace` 暴露追溯；旧记录可以没有此字段。内部 `executeAgent` 返回的 `trace` 由 service 摘除后再保存结果，因此 `results[step].value` 与追加到下游 prompt 的依赖 JSON 均不含 trace，不挤占原有单步结果 64KiB 配额。追溯字段如下：

| 字段 | 含义与边界 |
|---|---|
| `promptVersion` / `promptHash` | 当前版本 `xiaohe-worker-v1`；SHA-256 仅覆盖运行时持有的角色说明与对应输出契约，不覆盖整个宿主 system prompt 或继承的 preset |
| `taskPromptHash` | SHA-256 覆盖实际交给 Worker 的精确任务 prompt，含追加的直接依赖 JSON；不保存该 prompt 正文于 trace |
| `outputFormat` | 实际使用的 `text/report`（省略输入时为 `text`） |
| `selectedModel` | 创建 Worker 时选用的模型路由，字段为 `provider/model` 与可选 `reasoningEffort` |
| `requestModels` | `request/header` 记录的 resolved routes，按连续相同路由去重；不是请求次数、全局唯一模型集合或网络请求成功凭证 |

当前仅在 Worker 创建后、任务 `followup` 前写初始追溯 checkpoint，以及 `whenIdle` 返回且未取消后写更新；不随每次 `request/header` 持续落盘。取消/中途崩溃可能只有 initial 追溯和空 `requestModels`；空数组不证明没有发生模型请求。追溯不证明任务结论正确、权限更宽或已完成独立验收。

## 命令完成判定

- `pwsh` 必须返回已完成、退出码为 0、没有中断、超时、停止或沙箱拒绝的结果，才能放行依赖步骤。
- `input.run_in_background:true` 在计划受理前以 `RUNTIME_BACKGROUND_UNSUPPORTED` 拒绝，不启动任何步骤。
- 宿主自动转后台的 `promoted` 回执（或意外的 `background` 回执）不是命令完成：运行失败，命令步骤标 `unknown/RUNTIME_BACKGROUND_UNSUPPORTED`，下游不执行；结果中保留 `kind/jobId`，必须通过原生 `job_output/job_kill` 收集或停止宿主任务。运行时不自动重发，也不把取消运行等同于停止该 Job。

## 状态、取消与关闭

- 运行：`running | succeeded | failed | cancelled | interrupted`。
- 步骤：`pending | running | succeeded | failed | cancelled | unknown`。
- `unknown` 表示副作用是否完成无法确认，不是“未执行”；不自动重试或回滚。
- 同步 `runtime_run` 与 `runtime_resume` 绑定外层取消信号；仅不含 Agent 且调用未携带 `exec.toolSet` 的受控宿主计划支持 `async:true`，受理成功后脱离外层等待信号，用 `runtime_cancel` 显式取消。
- 取消立即停止新步骤调度，并向在途工具传播信号；未开始步骤标 `cancelled`，已开始的副作用标 `unknown`。忽略取消的工具可能继续，晚到结果不覆盖已提交终态。
- 超时的副作用或 Agent 步骤标 `unknown/RUNTIME_STEP_TIMEOUT`，运行失败；超时 `read/glob/grep` 步骤失败，不自动重试。Agent 取消/超时等待 Worker dispose；普通工具不保证实际停止。
- 卸载关闭服务后拒绝新操作，取消并等待本作用域调度退出；不取消其他作用域拥有的运行，也不承诺强杀不合作的宿主操作。

## 持久化与恢复

- 记录路径：`DSH_HOME/tmp/xiaohe-runtime/runs/<runId>.json`（`XIAOHE_RUNTIME_DIR` 可覆盖）。每次工具尝试前、每步完成和重试时写检查点；同目录唯一临时文件先 fsync 刷盘再原子替换，失败清理。掉电最多回退到上一检查点或由恢复扫描回收，Windows 不保证目录项级持久性；这仍不是分布式事务。
- 记录保留 version 1，新增可选进程所有权字段；新会话不会把本进程其他活跃运行误标中断。其他仍存活进程的记录在新鲜期内保守跳过；PID 探测存活不能证明属主身份，活属主每个步骤边界都写检查点且单次尝试受超时上界约束，故外部 PID 仍探测存活但超过 1 小时未写检查点的 `running` 记录按失联回收（防 PID 复用形成无法恢复、取消或清理的僵尸记录）。底层 RunStore 的进程字段只是兼容旧记录的恢复启发式，不能替代独占锁。当前 RuntimeService 在维护/恢复前取得规范化记录 root 的 `.runtime-owner.lock`，同模块同进程服务共享，其他持锁者（包括重复加载模块）拒绝 `RUNTIME_ROOT_LOCKED`；初始化失败释放新取得的锁，最后一个服务引用及本进程调度/owned Worker 收束后释放。锁是合作式本机互斥，不拦截旧版/直接 RunStore 或外部写入，不保证普通宿主工具/Job已停止，也不是分布式保证。
- 目录锁不按时间或 PID 自动抢占。崩溃、断电、损坏或无法确认的遗留锁保持拒绝；先停掉所有访问该 root 的宿主，备份记录、核验外部工作，再由操作者移除 `.runtime-owner.lock`。不要在线清锁；锁的时间/PID/token不是授权或进程身份凭证。直接使用底层 RunStore 的受控调用仍须自行保证独占。
- 仅失联的 `running` 记录标 `interrupted`，在途步骤标 `unknown`；不自动执行恢复。
- 显式恢复保留已保存成功步骤，仅 `read/glob/grep` 在途步骤重新排队；若存在未知副作用或未知 Agent，标 `failed/RUNTIME_INTERRUPTED` 并停止整个恢复计划，不再启动任何新步骤。**不保证 exactly-once**。
- 默认持续保留最近 100 个终态运行（`succeeded/failed/cancelled`），不删除 `running/interrupted`。中断记录可能长期保留，应由所有者确认后取消；本轮不提供 TTL 或归档接口。
- status/result/cancel/resume 只允许所有者会话。单步结果 >64KiB 只保存截断标记；记录读取上限 4MiB，结构、计划、步骤、结果和时间戳不一致的记录隔离忽略。
- `runtime_status` 列表和 `runtime_task` 附 `diagnostics`：当前存储实例有界累计计数 `invalidRecords/oversizedRecords/readFailures/writeFailures`，以及毫秒墙钟 `startedAt`（该存储实例创建时间，不是进程启动）、`observedAt`（本次快照读取时间）、`lastObservedAt`（固定四类键，最近一次计数观察时间，未观察为 null）。时间随墙钟可回拨，不是单调时长；计数和时间只在内存中，不持久化、不额外扫描或写盘，不含路径、ID或正文。重复扫描可重复计数，不代表坏文件去重数量；非法 runId 不计读取失败。历史错误不证明仍在持续，时间也不证明已恢复；不会清零计数、触发提醒或授予重试。
- 保存失败以 `RUNTIME_STORAGE_FAILED` 停止调度并尝试提交失败状态；若磁盘不可写，只能在进程内保留最多 100 个失败摘要，不能承诺重启后仍可查询。记录正文可能含敏感输入或结果，保管记录目录与权限仍是部署者责任。

## 错误码（运行时）

`INVALID_PLAN`、`PLAN_TOO_LARGE`、`PLAN_DUPLICATE_ID`、`PLAN_UNKNOWN_DEP`、`PLAN_CYCLE`、`PLAN_UNKNOWN_TOOL`、`PLAN_RETRY_DENIED`、`RUNTIME_NOT_FOUND`、`RUNTIME_INVALID_STATE`、`RUNTIME_STEP_TIMEOUT`、`RUNTIME_CANCELLED`、`RUNTIME_INTERRUPTED`、`RUNTIME_STEP_FAILED`、`RUNTIME_BUSY`、`RUNTIME_STORAGE_FAILED`、`RUNTIME_ROOT_LOCKED`、`RUNTIME_COMMAND_FAILED`、`RUNTIME_BACKGROUND_UNSUPPORTED`、`RUNTIME_ASYNC_ADMISSION_UNSUPPORTED`、`RUNTIME_TASK_LINK_INVALID`、`RUNTIME_RESULT_UNAVAILABLE`、`RUNTIME_RESULT_CHANGED`、`OWNING_SESSION_REQUIRED`、`CLOSED`。预设派生错误沿用 `PTC_PRESET_*`。

含 Agent 的异步提交预检使用 `RUNTIME_AGENT_ASYNC_UNSUPPORTED`；未注入可信适配器的入口对含 Agent 计划以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 预检拒绝；Worker 配额满载使用 `RUNTIME_AGENT_CAPACITY_EXCEEDED`。Agent 适配器使用 `RUNTIME_AGENT_INVALID_INPUT`、`RUNTIME_AGENT_WRITE_UNSUPPORTED`、`RUNTIME_AGENT_PARENT_REQUIRED`、`RUNTIME_AGENT_MODEL_REQUIRED`、`RUNTIME_AGENT_TOOLS_UNAVAILABLE`、`RUNTIME_AGENT_TOOL_DENIED`、`RUNTIME_AGENT_PARENT_POLICY_DENIED`、`RUNTIME_AGENT_ABORTED`、`RUNTIME_AGENT_STEP_LIMIT`、`RUNTIME_AGENT_TURN_FAILED`、`RUNTIME_AGENT_OUTPUT_MISSING`、`RUNTIME_AGENT_EXECUTION_FAILED`；报告解析使用 `RUNTIME_AGENT_REPORT_INVALID`、`RUNTIME_AGENT_REPORT_TOO_LARGE`；依赖传递使用 `RUNTIME_AGENT_DEPENDENCY_UNAVAILABLE`、`RUNTIME_AGENT_CONTEXT_TOO_LARGE`。错误码不代表底层操作已被强杀或内容已经验收。

## 兼容性

1.0 移除了 0.x 的 `execution_bus` 工具、完整 v1 消息信封、`./core` 导出与旧预设 ID；工具与导出变更属于主版本破坏。0.12.1 是最后一个总线版本。1.7.0 不改变上述破坏性变更边界，不自动安装或重启日常 DSH。

<a id="可信宿主-worker-扩展与离线提示词预览源码新增"></a>

## 可信宿主 Worker 扩展与离线提示词预览（1.7.0）

本节为 1.7.0 可信宿主及离线 API。模型工具输入、标准插件注册及 rc.1 Worker 门禁不变；不修改已安装宿主，不添加持久队列或自动重试。

### 依赖结果渐进读取

可信集成通过 new RuntimeService(ctx, store, delegationPolicy, workerHostOptions) 显式配置。workerHostOptions.dependencyReader 必须提供固定 toolName:"runtime_dependency_read" 与 bind(agent, context):()=>void。宿主需事先注册该只读工具、让父 toolSet 正常准入，并在 bind 中按 child 身份绑定 context.read，返回撤销函数；不得在模型参数里接收或跨 child 共享能力对象。未绑定调用必须拒绝；不允许工具同名替换绕过原生身份检查。每次工具调用仍经过原生权限管道与可信父策略适配器，bind 本身不授予文件或其他运行读取权限。标准插件不传该选项。

启用后，仅 agent 的明确 depends_on 成功且完整保存结果生成快照。初始每项最多256 Unicode码点预览，含 id/ref/hash/total；预览不是完整证据。context 持有 ownerSessionId/runId/stepId，仅交给可信宿主，模型只获得预览引用。读取输入为 {ref,hash,offset?,limit?}，offset默认0、limit默认2048且为1–4096，单位Unicode码点；输出 {ref,hash,offset,total,text,nextOffset?}。拼接所有 text 后才能解析完整JSON。未知字段、非法offset/limit报 INVALID_PLAN，非本闭包引用报 RUNTIME_RESULT_UNAVAILABLE，hash不符报 RUNTIME_RESULT_CHANGED。引用不是跨调用授权，不落盘、不跨重启复用；调用结束、取消、超时后读取失效。快照不随原记录的后续变化更新。

单步结果超过原64KiB保存限制而被丢弃、缺失或未成功时仍报 RUNTIME_AGENT_DEPENDENCY_UNAVAILABLE，不提供虚假全文；预览与任务prompt合计超过原上下文限制仍报 RUNTIME_AGENT_CONTEXT_TOO_LARGE。默认不配置读取器时仍使用原全文注入及聚合超限拒绝。普通工具不插值，结果仍是不可信资料，不授权、不自动补读或恢复。

### 模型等待观察

workerHostOptions.onModelWait(sessionId,status) 是可信宿主只读回调，不是模型工具。status 为 {provider,reason,attempts,since,lastAt,nextRetryAt?} 或 undefined，时间单位毫秒；reason 为 budget/rate_limit/authentication/context_limit/transient/other。仅根据实际收到的 llm/retry 结构化失败字段分类，不解析错误正文；llm/retry-started 不算恢复，重复/旧序列与旧provider输出不清除当前等待。生命周期结束清理观察，回调异常不改变执行。回调可能收到相同状态，宿主自行去重；不应逐事件推送通知。

当前 rc.1 不保证发出重试事件，undefined 只说明没有活动观察，不证明网络或模型健康。此信息不写运行记录，不更改重试/超时策略、不换模型、不证明模型请求成功或外部工作结束。包入口也导出 ModelWaitObserver 供宿主按每个Session独立消费事件，不能混用事件流。

### 离线业务提示词预览

包入口导出 createBusinessPromptOverrides({communication?,delivery?,baseRevision?})、previewBusinessPrompt({overrides?,baseRevision?})、compareBusinessPrompts({before,after,baseRevision?})。只允许 communication/delivery 两个业务段；每段非空、最多8192 UTF-8字节，拒绝未知字段、访问器、控制字符和非法代理对。安全文本直接来自本地 WORKER_ROLE_INSTRUCTIONS，不能通过参数替换；这不等于对任意业务文本做语义安全认证。

factory 给新覆盖文本标记当前默认段 baseHash；preview 显示 source/defaultHash/baseHash/drifted、defaultsRevision/revision，以及 applied:false/authorized:false/executable:false。factory/preview 的可选 baseRevision 与当前 defaultsRevision 比较；compare 的顶层 baseRevision 与 before 的预览 revision 比较。错误为 PROMPT_PREVIEW_INVALID_INPUT 或 PROMPT_PREVIEW_STALE_REVISION，不回显输入。compare 分开报告内容、基线及默认值漂移；旧基线不自动重置。

这些是纯离线检查函数，不读取持久历史、不保存配置、不接入Worker、不调用模型或修改权限。hash只是输入差异与版本一致性检查，不证明历史真实性、批准或作者身份；持久历史须由宿主显式调用下述 BusinessPromptHistory，不能把预览接口说成完整配置后台。

<a id="离线业务提示词版本历史源码新增未发布"></a>

### 离线业务提示词版本历史（1.7.0）

包入口导出 `BusinessPromptHistory`，可信宿主显式指定存储目录；不是模型工具，不接入运行中的 Worker。

```ts
import { BusinessPromptHistory, createBusinessPromptOverrides, previewBusinessPrompt } from "@feng0531/dsh-execution-bus";
const history = new BusinessPromptHistory(hostChosenDirectory);
const current = history.read();
const saved = history.save({
  expectedRevision: current.revision, source: "local-operator",
  overrides: createBusinessPromptOverrides({communication: "简洁说明事实与不确定性"}),
});
const original = history.get(saved.revision);
const preview = previewBusinessPrompt({overrides: original.overrides});
// 仅离线预览，不应用、不授权、不调用模型。
```

- read() 返回当前 revision 和新到旧 items；history() 返回同样摘要数组；get(revision) 返回该修订；save({expectedRevision,source,overrides}) 追加保存。source 非空、最多 256 UTF-16 单元，拒绝控制字符和非法代理对；overrides 沿用两段业务文本校验，不允许安全段或额外键。
- 保存字段 revision/previousRevision/savedAt/source/defaultsRevision/overrides/previewRevision；新记录另含 runtime 自取的 businessDefaults，仅保存 communication/delivery 的 text/hash，不接受调用者传入。首条 revision=1、previousRevision=null。返回值均带 applied:false/authorized:false/executable:false，脱离存储对象；摘要不含 overrides 或 businessDefaults 正文。source 是调用者标签，不证明操作者身份。
- 最多 32 个修订，满时拒绝、不淘汰；文件最多 1MiB。存于指定目录的 business-prompt-history.json，通过 .business-prompt-history.lock 独占写锁、revision CAS、同目录临时文件 fsync 后原子替换。损坏、超限或遗留锁均拒绝，不重置、不抢锁。修复遗留锁前须停掉所有写入者并备份核验；不保证断电后的目录项级持久性，也不防外部不合作改写。
- 历史保留原 defaultsRevision 与业务段 baseHash，升级后不重设基线。previewRevision 使用原 defaultsRevision 和覆盖文本检查一致性；不保存安全提示词，不承诺复现旧版完整 prompt。新读取器兼容没有 businessDefaults 的 version 1 旧记录，不补造或回写旧正文；新增可选字段的文件不能交回不认识该字段的旧读取器。
- `defaultChanges(revision)` 返回离线 `{revision,items,applied:false,authorized:false,executable:false}`。items 固定为两业务段，每项含 section、baseHash（无旧基线时 null）、currentHash、status:known/unknown、drifted（无基线时 null）、currentText；known 时另含 previousText，供宿主展示前后文本差异。覆盖按其 baseHash、未覆盖按该修订保存的默认 hash，在同段历史快照中查找；legacy 无快照保持 unknown，不借当前正文冒充旧默认。未知 base 仍可判断 hash 是否漂移，但没有 previousText。
- 默认正文每段沿用 8KiB、合法 UTF-16 与控制字符校验；保存的 text/hash 必须一致，未知段或额外键拒绝。known 仅说明本地历史可解析且 hash 匹配，不证明历史真实性、用户批准或完整 prompt 可重放；本地文件不防不合作改写。该方法不保存、不应用、不调用模型，不提供文本自动合并或安全段覆盖。
- 错误码前缀 PROMPT_HISTORY_：INVALID_INPUT、STORAGE_FAILED、INVALID_STATE、STALE_REVISION、BUSY、FULL、NOT_FOUND；错误不回显路径或正文。内容可能敏感，宿主负责目录访问控制，不把任意目录参数交给普通模型。没有自动加载、回滚应用、模型调用、权限变更或发布。
