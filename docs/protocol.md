# 协议与运行语义

多 Agent 扩展随 1.4.0 发布；运行判读与 owner 复核处置随 1.5.0 发布，沿用从 PTC 派生的 `xiao-he-runtime`，不新增 team 模式，历史 1.0/0.x 变更不因此重写。

## 工具

| 工具 | 输入 | 返回 |
|---|---|---|
| `runtime_capabilities` | `{}` | 描述当前调用上下文的能力与限制，不执行准入检查、不创建 run |
| `runtime_run` | `{ plan, async? }` | 同步：运行摘要与步骤状态；仅不含 Agent 且调用未携带 `exec.toolSet` 的受控宿主计划可用 `async:true`：受理后立即返回 `{ runId, state:"running" }` |
| `runtime_status` | `{}`、`{ limit?, offset? }` 或 `{ runId }` | 本会话最近运行列表与脱敏存储诊断，或指定运行元数据（不含结果） |
| `runtime_result` | `{ runId }` 或下述分页参数 | 运行摘要 + `acceptance` + 已保存步骤结果（`truncated/bytes` 标记）；分页同样含 `acceptance` |
| `runtime_review` | `{runId,snapshotHash,expectedRevision,disposition,reason}` | 记录 owner 处置并返回摘要与 `ownerReviewHistory`；不是独立验收 |
| `runtime_cancel` | `{ runId }` | 发起取消后的运行摘要；不保证 Worker 已清理或宿主操作已实际停止 |
| `runtime_resume` | `{ runId }` | 同步等待恢复结果；仅 `interrupted` 可恢复 |

列表 `limit` 为 1–100，默认 20；`offset` 为 0–10000，默认 0。先按所有者过滤，再按更新时间降序分页；同时间以运行 ID 稳定排序。指定 `runId` 时不能同时提供分页参数。所有工具拒绝未知字段。

运行摘要与列表新增派生 `progress`（各步骤状态计数）及 `guidance`（未知副作用、后台 Job 和中断处置提示）。它们仅在会话归属检查后生成，不写入 version 1 记录。建议操作不是授权，不会自动执行 Job、恢复或重发。工具的 JSON 文本返回保留，另提供宿主支持的结构化输出及展示摘要；实际桌面效果需独立验收。

### 能力说明

`runtime_capabilities({})` 返回 `ordinaryDag:"supported"`、`worker:"conditional"|"unavailable"`、`workerReason`、`ordinaryAsync:boolean`、`workerAsync:false`、`workerTools`、`limits`、`authorization:"checked_at_execution"` 和说明 `message`。普通 DAG 每次执行仍由宿主准入；这不是查询授权、资源保留或真实工具/模型可用性探测。

仅可信 `DelegationPolicyAdapter` 存在且父 `exec.toolSet` 存在时 Worker 标为 `conditional`，表示仍需执行期检查；否则为 `unavailable`。对应 `workerReason` 为 `trusted_adapter_missing`、`parent_admission_missing` 或 `execution_checks_required`。标准插件入口未接入适配器，不能据此声称 Worker 门禁已修复。`ordinaryAsync` 仅在无 `toolSet` 时为 true；Worker 异步始终不可用，不得删除父准入集合绕过限制。

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
- `attention.notification:{key,shouldNotify}`：同一事项集合生成稳定 SHA-256 键，常规运行进度无事项时 shouldNotify=false。更新时间、尝试次数不单独触发新键；键供上层合并提醒，不表示已发送、已读或已处理。读取不确认事项，不持久化通知收据。
- `waiting:{steps,cleanupPending}`：仅 running 的 pending 步骤列出 dependency（依赖未成功）、scheduler（依赖已满足，等待后续批次）或 retry_backoff（当前进程实际处于只读重试退避）。仅真实退避观察附 waitingSince、nextRetryAt（毫秒时间戳）和枚举 retryCategory，不从错误正文推断。nextRetryAt 不是执行保证。

退避观察仅存在于当前进程、当前 RunRecord，不写入 v1 记录，重启后不推断历史等待时间。cleanupPending 仅表示已知本进程运行 Promise 在终态后尚未收束，不证明外部工作停止。当前无容量等待队列，不展示虚构 capacity 等待。

展示卡优先呈现待处理事项，常规逐步状态和重复 Worker 验收提醒收敛到 JSON；旧返回值没有这些字段时仍使用原展示。不改变状态/依赖成功条件、不自动执行恢复、不新增独立验收、Outbox 或工单；owner处置另见下节；列表只聚合当前页的本会话运行，不是全量全局待办。

### Owner 复核处置

摘要与列表提供 `ownerReview`：revision、status（not_recorded/stale/accepted/needs_work）、可选 snapshotHash/recordedAt；verification 固定为 owner_declared_not_independently_verified。result（含分页）和 review 返回 ownerReviewHistory，理由仅在这两个 owner 专属结果中返回，不进入展示元数据或列表。

读取全部结果与证据后，调用 `runtime_review({runId,snapshotHash,expectedRevision,disposition,reason})`。hash/revision 从当前 ownerReview 读取；disposition 为 accepted 或 needs_work，理由非空且最多2048 UTF-8字节。快照绑定 runId、归一化计划、步骤工具/状态/尝试次数和每项完整 value JSON SHA-256；计划或结果变化使旧处置 stale。hash不证明读取或证据真实性。

首版只允许非活动、成功且全部结果完整的持久化运行，拒绝清理在途、失败、取消、中断、缺失/截断和易失存储失败记录。所属会话取自宿主 exec.agent.id，参数不能声明 reviewer/人工身份；Worker 与普通 DAG 步骤均不开放此工具。owner调用者可能也是模型，accepted只代表该会话声明，不是独立验收、人工批准或后续执行授权；acceptance.status仍为not_reviewed。仅匹配当前快照的accepted收敛review_results提醒，needs_work/stale保留；未知副作用、失败和待决问题不因此消失，不自动重跑。

记录存于 version 1 run 的可选 ownerReviews，最多32条，超限拒写而不驱逐。记录不改变运行时间、状态和保留排序，随终态运行一起按既有策略清理，不是永久审计库；旧版读取器不认识此字段，使用处置后的记录目录不能交给旧版写入。坏记录继续严格拒读，不默认为未处置。

写入使用每run排他 `.review-lock`，在锁内重新读取并检查owner/hash/revision，陈旧值报RUNTIME_RESULT_CHANGED，锁忙报RUNTIME_BUSY。运行删除/保留清理也遵守该锁（锁忙跳过删除）。锁内沿用临时文件/fsync/rename；失败不先更新内存。崩溃遗留锁不会自动抢占，应先停掉所有访问该目录的宿主、备份运行记录并核验结果，再由操作者移除对应锁；不要在线清锁。此互斥仅覆盖新版本的review/remove，不为外部文件修改或旧版写入提供事务保证，不承诺掉电绝不回退。

## 计划（plan）

`plan = { goal?, task_id?, previous_run_id?, concurrency?, steps[] }`；`step = { id, tool, input, depends_on?, retry?, timeout_ms? }`。

- 允许步骤：`read/glob/grep/edit/write/pwsh/agent`；`retry` 只允许 `read/glob/grep`（0–3）。依据结构化类别/代码判定重试；确定性权限、参数、资源不存在等错误不重试，已知瞬态可重试。无结构化信息的未知错误保留旧重试行为，不解析错误正文。退避为 100/200/400ms，等待可取消；超时不自动重试，避免上次调用未实际停止时发生重叠。宿主未保留的原始错误字段不可凭空恢复，宿主 canonical error.info 之外的信息不作为分类依据。
- 约束：1–32 步；计划 ≤64KiB；并发 1–4；单步超时 1s–600s；`id` 唯一、依赖必须存在、禁止环。
- `depends_on` 表示成功后的执行顺序；仅 `agent` 将直接依赖结果追加到 prompt，其他工具输入不插值。普通工具输入按宿主工具自身 schema、父调用权限和工作目录执行。
- 调度为有界批次：一批结束后才启动下一批。只读 Agent 可与 `read/glob/grep/agent` 同批并行，但不能与本 run 的 `edit/write/pwsh` 同批；不锁跨 run 或外部写入。任一步失败后不再调度新批次；同批已开始的操作不保证回滚。
- 同一进程、同一规范化记录目录分别共享最多 8 个活跃运行和 8 个 Worker；新建和恢复共用 run 配额。Worker 在 agents.create 前同步占槽，创建、执行和清理全部计数，executeAgent（含 dispose）结束后才释放。满载步骤失败 `RUNTIME_AGENT_CAPACITY_EXCEEDED`，不隐式排队、不自动重试；其他 root 或进程不共用。
- `task_id` 为字母开头、可含字母/数字/_- 的 1–64 字符标识。`previous_run_id` 要求同时提供 task_id；前驱必须仍可读取、同 owner、同 task，已处于 succeeded/failed/cancelled 且没有活动清理，才可创建新 run。归属不匹配/缺失报 RUNTIME_NOT_FOUND；task 或状态不符报 RUNTIME_TASK_LINK_INVALID。关联仅为历史，不复用结果、不扩展权限、不替代 resume；保留策略不因关联变化。摘要和列表以可选 taskId/previousRunId 投影，旧记录可缺省。

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
- 记录保留 version 1，新增可选进程所有权字段；新会话不会把本进程其他活跃运行误标中断。其他仍存活进程的记录在新鲜期内保守跳过；PID 探测存活不能证明属主身份，活属主每个步骤边界都写检查点且单次尝试受超时上界约束，故外部 PID 仍探测存活但超过 1 小时未写检查点的 `running` 记录按失联回收（防 PID 复用形成无法恢复、取消或清理的僵尸记录）。迟到的原属主再次写检查点会把状态覆盖回去；本协议不提供跨进程锁或分布式保证。
- 仅失联的 `running` 记录标 `interrupted`，在途步骤标 `unknown`；不自动执行恢复。
- 显式恢复保留已保存成功步骤，仅 `read/glob/grep` 在途步骤重新排队；若存在未知副作用或未知 Agent，标 `failed/RUNTIME_INTERRUPTED` 并停止整个恢复计划，不再启动任何新步骤。**不保证 exactly-once**。
- 默认持续保留最近 100 个终态运行（`succeeded/failed/cancelled`），不删除 `running/interrupted`。中断记录可能长期保留，应由所有者确认后取消；本轮不提供 TTL 或归档接口。
- status/result/cancel/resume 只允许所有者会话。单步结果 >64KiB 只保存截断标记；记录读取上限 4MiB，结构、计划、步骤、结果和时间戳不一致的记录隔离忽略。
- `runtime_status` 列表附 `diagnostics`：当前存储实例有界累计计数 `invalidRecords/oversizedRecords/readFailures/writeFailures`，不含记录路径或正文；重复扫描可重复计数，不代表损坏文件去重数量；非法 runId 属调用方错误，不计入读取失败。
- 保存失败以 `RUNTIME_STORAGE_FAILED` 停止调度并尝试提交失败状态；若磁盘不可写，只能在进程内保留最多 100 个失败摘要，不能承诺重启后仍可查询。记录正文可能含敏感输入或结果，保管记录目录与权限仍是部署者责任。

## 错误码（运行时）

`INVALID_PLAN`、`PLAN_TOO_LARGE`、`PLAN_DUPLICATE_ID`、`PLAN_UNKNOWN_DEP`、`PLAN_CYCLE`、`PLAN_UNKNOWN_TOOL`、`PLAN_RETRY_DENIED`、`RUNTIME_NOT_FOUND`、`RUNTIME_INVALID_STATE`、`RUNTIME_STEP_TIMEOUT`、`RUNTIME_CANCELLED`、`RUNTIME_INTERRUPTED`、`RUNTIME_STEP_FAILED`、`RUNTIME_BUSY`、`RUNTIME_STORAGE_FAILED`、`RUNTIME_COMMAND_FAILED`、`RUNTIME_BACKGROUND_UNSUPPORTED`、`RUNTIME_ASYNC_ADMISSION_UNSUPPORTED`、`RUNTIME_TASK_LINK_INVALID`、`RUNTIME_RESULT_UNAVAILABLE`、`RUNTIME_RESULT_CHANGED`、`OWNING_SESSION_REQUIRED`、`CLOSED`。预设派生错误沿用 `PTC_PRESET_*`。

含 Agent 的异步提交预检使用 `RUNTIME_AGENT_ASYNC_UNSUPPORTED`；未注入可信适配器的入口对含 Agent 计划以 `RUNTIME_AGENT_POLICY_UNSUPPORTED` 预检拒绝；Worker 配额满载使用 `RUNTIME_AGENT_CAPACITY_EXCEEDED`。Agent 适配器使用 `RUNTIME_AGENT_INVALID_INPUT`、`RUNTIME_AGENT_WRITE_UNSUPPORTED`、`RUNTIME_AGENT_PARENT_REQUIRED`、`RUNTIME_AGENT_MODEL_REQUIRED`、`RUNTIME_AGENT_TOOLS_UNAVAILABLE`、`RUNTIME_AGENT_TOOL_DENIED`、`RUNTIME_AGENT_PARENT_POLICY_DENIED`、`RUNTIME_AGENT_ABORTED`、`RUNTIME_AGENT_STEP_LIMIT`、`RUNTIME_AGENT_TURN_FAILED`、`RUNTIME_AGENT_OUTPUT_MISSING`、`RUNTIME_AGENT_EXECUTION_FAILED`；报告解析使用 `RUNTIME_AGENT_REPORT_INVALID`、`RUNTIME_AGENT_REPORT_TOO_LARGE`；依赖传递使用 `RUNTIME_AGENT_DEPENDENCY_UNAVAILABLE`、`RUNTIME_AGENT_CONTEXT_TOO_LARGE`。错误码不代表底层操作已被强杀或内容已经验收。

## 兼容性

1.0 移除了 0.x 的 `execution_bus` 工具、完整 v1 消息信封、`./core` 导出与旧预设 ID；工具与导出变更属于主版本破坏。0.12.1 是最后一个总线版本。本轮不变更包版本，不自动安装、重启或发布。
