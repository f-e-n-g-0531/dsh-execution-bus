# 运行状态与故障处置

本文面向使用者。运行时停止调度不等于外部工具已经停止，也不等于副作用回滚；不要因为看到 cancelled/failed 就重复提交写操作。

## 如何查看

1. 保存 runtime_run 返回的 runId。同一会话用 runtime_status 查询状态、runtime_result 读取已保存结果。
2. 查看失败步骤及错误码；pending 表示尚未执行，不表示运行仍会继续。interrupted 必须显式处理。
3. unknown 表示副作用是否完成无法确认。先检查实际文件、命令产生的业务记录和后台 Job，不要自动重发。
4. 不要轮询仍在同步等待的 runtime_run；异步运行按需查询，不用紧密循环。

## 能力与恢复判读

先用 `runtime_capabilities({})` 了解当前调用上下文。`ordinaryDag:"supported"` 不是授权；Worker 仅在可信适配器和父 `toolSet` 同时存在时为 `conditional`，否则为 `unavailable`。这不保留资源、不探测真实模型，也不代表标准插件适配器已修复。普通异步仅在无 `toolSet` 时允许，`workerAsync` 始终为 false；不要移除准入集合绕过门禁。

单 run 摘要的 `recovery` 可协助判读，仍需结合步骤错误与实际外部状态：

| 字段/建议 | 安全判读 |
|---|---|
| `resultCertainty:recorded/incomplete/unknown` | 分别描述已记录、不完整或存在未知状态；recorded 不是任务验收通过 |
| `cleanup:pending/settled/unknown` | 仅本进程调度及 owned Worker 收束观察；重启后缺少观察为 unknown，settled 不证明外部 Job 停止 |
| `externalWork:unconfirmed` | 始终未确认外部工作停止或副作用回滚 |
| `nextAction:wait` | 本进程仍运行/清理；不要轮询仍在同步等待的调用 |
| `nextAction:inspect_external_state` | 先核对外部进程、文件和 Job，再决定是否另行操作，禁止自动重发 |
| `nextAction:resume_read_only` | 仅建议检查只读恢复；显式 resume 仍受原有中断与权限门禁约束 |
| `nextAction:review_results` | 取已保存结果并由 Lead 复核，不等于任务通过 |
| `nextAction:inspect_failure` | 核对失败步骤、错误及记录完整性，不把失败等同于未写入 |

`message` 是说明，不是指令或权限。上述字段不改变调度/恢复权限，不自动恢复、收集或停止 Job；不新增数据库、outbox 或工单。

## 决策请求处置（1.7.0）

Worker 请求决策不代表暂停等待批准。先用 runtime_result 核实报告与证据，再由原 owner 显式调用 runtime_decision，记录 answered（须答复引用）、superseded 或 dismissed；仅已收束的终态源运行可写。参数与示例见[协议](<protocol.md#决策处置关联源码新增未发布>)。

已知悉不等于已回答；处置记录也不等于用户批准、解决或验收。可关联已存在的直接后继运行，但不会创建或继续执行它。当前版本已处置项保留展示、不再默认提醒；问题版本变化后重新待处理，未知副作用等其他风险不受影响。源记录沿用既有保留策略，不保证永久历史。

## 读取待复核输出

```ts
const saved = await tools.runtime_result({ runId });
console.log(saved.recovery);
console.log(saved.acceptance.status); // 始终 not_reviewed
for (const worker of saved.acceptance.workers) {
  console.log(worker.stepId, worker.state, worker.resultHash, worker.reportOutcome);
  // 独立核对 saved.results[worker.stepId]?.value 的原始报告与证据。
}
```

`acceptance` 包括 Worker 状态、可选结果哈希和报告/criteria 计数，不回显报告自由文本。需大结果时使用协议中的分页读取；分页同样带 acceptance，`resultHash` 与该步骤 value JSON 的 SHA-256（`page.hash`）一致，绑定输出但不是验收。缺失/截断不能从汇总恢复证据；哈希不匹配时重新读取并核对输出版本，不混拼页面。

`runtime_status` 只看元数据，不含 report 内容。`not_reviewed` 不会被 Worker 自授为 accepted，运行时也不持久化独立验收证明；新增 runtime_review 仅记录 owner 声明的处置，不能证明人工或独立复核。即使 `succeeded`、`reportOutcome:completed` 或 `criteria.observed`，仍须核实证据、局限和待决事项；无 Worker 的空数组同样不证明任务通过。

## 记录 owner 处置

先读取完整结果并核实证据；仅成功且全部结果完整、已离开活动/清理窗口的运行可用。将 result.ownerReview 的 snapshotHash 和 revision 分别传给 runtime_review 的 snapshotHash、expectedRevision，并提供 disposition（accepted/needs_work）和非空理由。返回 ownerReviewHistory 留存最多32条；历史理由不会进入展示卡片。accepted仅为owner会话声明，不是人工/独立验收证明，不会授权或执行下一步。需要补证据时用needs_work，旧hash或revision被拒绝后应重新读取，不要盲目覆盖。

结果或计划变化使处置stale；新run不继承旧处置。记录随run清理，不是永久账本。锁忙报RUNTIME_BUSY，不自动重试或偷锁；崩溃残留锁的离线处置边界见[协议](<protocol.md#owner-复核处置>)。

## 优先查看待处理事项

摘要与本会话列表项的 `attention.items` 仍保留外部核验、失败、Worker 待决、结果缺失/截断和结果待复核。卡片默认只展开前四类必须处理事项；结果待复核留在详情，不触发默认提醒。卡片不重复逐步进度；完整状态、guidance 和结果仍保留在 JSON。待决事项只给步骤与结果哈希入口，须读取原报告后由 Lead 判断，不能把它当执行授权或自动暂停。

没有必须处理事项时 `notification.shouldNotify=false`。上层可按 `notification.key` 合并同一提醒，也可在自己的界面忽略该键；忽略不是运行时状态，不改变结果，也不算验收。键不是已发送、已读或已忽略标志，查询不会确认或清除事项；本运行时没有外部推送或投递去重；问题已知悉需显式调用 runtime_acknowledge，查询本身不会写记录。当前页只汇总各类事项计数，不折叠不同运行；即使事项相同，也逐项保留每个 runId、状态、结果读取入口与 Job 提示。所有待办均提供只读 runtime_result 定位；恢复、Job 处置和 owner 复核仍须先检查证据后显式请求，不自动执行。

`waiting.steps` 区分等待依赖、等待调度槽或后续批次、真实重试退避。当前源码的纯 `read/glob/grep` 计划完成即补槽，含其他工具的计划保持批次调度；重试退避仍占步骤槽位，不重复派发。退避若带 `disposition:waiting_retry`，表示本次失败按既有策略等待只读重试，不升级为待处理；`needs_action` 表示该类别不能据此重试。仅退避有实际观察到的开始和下次尝试时间。重启不补猜时间，终态不再显示待执行步骤为活跃等待。清理等待仅指本进程，不代表外部 Job 退出；容量满仍按原行为拒绝，并未新增队列，也未给 edit/write/pwsh/agent 增加自动重试。

## 记录问题已知悉（1.6.0）

先读取问题及已保存结果，在原 owner 会话用 runtime_acknowledge 提交当前 attention 的 snapshotHash、items[].key、revision（作为 expectedRevision）和非空 reason。仅已停止调度的 succeeded/failed/cancelled 运行可用，活动/清理中/interrupted 拒绝。不要为了知悉而取消待恢复运行。

已知悉不等于解决或验收，失败和风险仍在卡片中；普通问题减少重复提醒，未知副作用即使知悉仍警示并提醒。执行问题版本变化后旧知悉失效。每run最多32条，记录随run清理；完整历史由 runtime_result 返回，理由不进入展示。新版本快照不是结果分页 hash。锁忙和离线清锁边界与 owner 复核相同，不自动覆盖旧revision。成功结果验收处置仍走 runtime_review。

## 常见故障

| 情况 | 安全操作 | 不能据此推断 |
|---|---|---|
| RUNTIME_AGENT_POLICY_UNSUPPORTED | 标准插件未接可信父策略适配器，改用原生委派或普通工具 DAG | 查询能力即可授权或修好适配器 |
| RUNTIME_ASYNC_ADMISSION_UNSUPPORTED / RUNTIME_AGENT_ASYNC_UNSUPPORTED | 改用同步调用；保留父 toolSet，不重新解析或删去准入集合 | 普通异步/Worker 异步已获授权 |
| RUNTIME_RESULT_UNAVAILABLE / RUNTIME_RESULT_CHANGED | 前者无可读保存 value 或已截断；后者输出版本已变，应重新取页核对 | 分页能恢复丢弃内容或跨版本拼接 |
| RUNTIME_STEP_FAILED | 检查宿主返回与权限；只读普通失败可在原计划配置 retry，副作用须先核对 | 失败意味着没有写入 |
| RUNTIME_STEP_TIMEOUT | 核对工具是否仍运行；只读超时也不立即重试，避免与不合作的原调用重叠 | 超时就是进程已退出 |
| RUNTIME_CANCELLED | 用 runtime_result 检查 unknown；必要时通过宿主工具确认停止 | cancelled 就是已回滚 |
| RUNTIME_INTERRUPTED | 对纯只读在途步骤可 runtime_resume；已保存成功步骤不重放。未知副作用会使整个恢复计划失败 | 所有中断运行都可安全恢复 |
| RUNTIME_BACKGROUND_UNSUPPORTED | 读取结果中的 kind/jobId，按下节使用原生 Job 工具 | Job 回执等于命令完成 |
| RUNTIME_BUSY | 等待现有运行结束或显式取消不再需要的运行；run/resume 共用 8 个配额 | 新建作用域会扩大配额 |
| RUNTIME_STORAGE_FAILED | 停止后续写入，检查记录目录可写性、磁盘空间和实际副作用；修复后重新核对 | 内存中的失败摘要可在重启后恢复 |

## 后台任务闭环

自动转后台时运行会失败、命令步骤为 unknown；依赖步骤不会放行。运行时只保存 Job 句柄，不自动收集、停止或重发。

在拥有该运行的原会话中：

~~~ts
const saved = await tools.runtime_result({ runId });
const receipt = saved.results.command?.value; // command 替换为计划里的步骤 ID
if (receipt?.jobId) {
  // 按当前宿主 schema 调用，检查返回的真实状态。
  const output = await tools.job_output({ job_id: receipt.jobId, wait: false });
  console.log(output);
  // 若任务不再需要，显式停止；发出停止请求仍不等于外部进程已经退出。
  // await tools.job_kill({ job_id: receipt.jobId, reason: "不再需要此任务" });
}
~~~

随后检查 Job 终态和实际输出。对于不合作工具，还需核对外部进程与业务副作用。不要把 Job 后来成功自动改成原运行 succeeded；重新规划前必须独立确认结果。

## 中断记录与敏感数据

- 默认只保留最近 100 条终态；running/interrupted 不受此预算清理。长期中断记录由原会话所有者先核对，再用 runtime_cancel 明确结束其恢复意图。取消后会进入终态保留策略，可能被清理。
- 需要调查时，先保留受控的记录副本，再取消。归档不代表工具停止；不要直接编辑状态 JSON 来强行恢复。
- 不要在宿主运行期间批量移动、删除或修改记录目录。1.7.0 新增 RuntimeService 的进程级目录独占锁：同模块同进程服务共享，其他持锁者启动报 `RUNTIME_ROOT_LOCKED`；最后服务与本进程调度/owned Worker收束后才释放，不证明普通宿主工具/Job已退出。没有自动 TTL 或归档 API，仍不要让多个宿主进程共享同一记录 root。
- `.runtime-owner.lock` 不按超时/PID自动清除；崩溃遗留、损坏和不确定锁都拒绝启动。先停止所有相关宿主、备份记录、核验外部工作，再由操作者删除该锁。不要在线清锁；旧版和直接 RunStore 不参与此合作锁，不受它保护。
- 记录含计划输入、命令或结果正文。按本机账号设置目录访问权限，禁止公开上传；哈希会话标识也不等于匿名。
- 单步结果超过 64KiB 只有截断标记，不能从运行记录取回完整正文；大输出应由原生工具保存在受控文件中并单独读取。
- 原子替换只提供当前进程故障恢复基础，不是断电事务。磁盘不可写时最多保留进程内失败摘要；重启后可能只剩最后成功落盘的状态。

协议定义见[协议与恢复边界](<protocol.md>)；隔离验收步骤及证据工具见[流程测试](<FLOW-TEST.md>)。
