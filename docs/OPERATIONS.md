# 运行状态与故障处置

本文面向使用者。运行时停止调度不等于外部工具已经停止，也不等于副作用回滚；不要因为看到 cancelled/failed 就重复提交写操作。

## 如何查看

1. 保存 runtime_run 返回的 runId。同一会话用 runtime_status 查询状态、runtime_result 读取已保存结果。
2. 查看失败步骤及错误码；pending 表示尚未执行，不表示运行仍会继续。interrupted 必须显式处理。
3. unknown 表示副作用是否完成无法确认。先检查实际文件、命令产生的业务记录和后台 Job，不要自动重发。
4. 不要轮询仍在同步等待的 runtime_run；异步运行按需查询，不用紧密循环。

## 常见故障

| 情况 | 安全操作 | 不能据此推断 |
|---|---|---|
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
