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

摘要与本会话列表项的 `attention.items` 优先列出外部核验、失败、Worker 待决、结果缺失/截断和结果待复核。卡片不重复逐步进度；完整状态、guidance 和结果仍保留在 JSON。待决事项只给步骤与结果哈希入口，须读取原报告后由 Lead 判断，不能把它当执行授权或自动暂停。

常规进度没有提醒事项时 `notification.shouldNotify=false`；上层可按 `notification.key` 合并同一事项提醒。键不是已发送/已读标志，查询不会确认或清除事项；本轮没有外部推送或持久化去重账本。

`waiting.steps` 区分等待依赖、等待批次调度、真实重试退避；仅退避有实际观察到的开始和下次尝试时间。重启不补猜时间，终态不再显示待执行步骤为活跃等待。清理等待仅指本进程，不代表外部 Job 退出；容量满仍按原行为拒绝，并未新增队列。

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
- 不要在宿主运行期间批量移动、删除或修改记录目录。当前没有自动 TTL、归档 API 或跨进程写锁；不要让多个宿主进程共享同一记录 root。
- 记录含计划输入、命令或结果正文。按本机账号设置目录访问权限，禁止公开上传；哈希会话标识也不等于匿名。
- 单步结果超过 64KiB 只有截断标记，不能从运行记录取回完整正文；大输出应由原生工具保存在受控文件中并单独读取。
- 原子替换只提供当前进程故障恢复基础，不是断电事务。磁盘不可写时最多保留进程内失败摘要；重启后可能只剩最后成功落盘的状态。

协议定义见[协议与恢复边界](<protocol.md>)；隔离验收步骤及证据工具见[流程测试](<FLOW-TEST.md>)。
