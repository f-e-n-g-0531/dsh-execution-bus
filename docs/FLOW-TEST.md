# 流程测试说明

1. 对当前源码执行 check、verify:package、pack:candidate，在隔离 DSH 配置安装同一候选 tgz，确认预设 **xiao-he-runtime** 出现且默认预设未变。不要覆盖日常配置，不要以另开网页服务器代替现有桌面。
2. 在目标预设的实际 `run_code` 中，通过生成 SDK 调用 `runtime_run`，提交两独立 read + 依赖 write/pwsh 的计划，核对真实文件、结果、cwd 和父权限链；普通预设仍无运行时工具。分别运行只读拒绝、工作区允许写/工作区外拒绝，以及审批拒绝，核对禁止路径没有副作用。
3. 标准模型调用携带 `exec.toolSet` 时，普通工具 `async:true` 计划应在创建 run 前报 `RUNTIME_ASYNC_ADMISSION_UNSUPPORTED`，且无步骤副作用；改用同步调用。仅无批次准入集合的受控宿主集成可提交普通工具 `async:true` 计划，用 `runtime_status`/`runtime_result` 取回，成功接收后外层 signal 不应取消它。同步 run/resume 应绑定外层 signal；`runtime_cancel` 应及时停止调度，但不能据此断言不合作工具已退出或副作用已回滚。
4. 中断宿主后重启并检查 `runtime_status`：遗留运行应为 `interrupted`。检查每步 checkpoint 已保存成功步骤；resume 可重排在途只读步骤，但未知副作用必须使整个 run 失败且不调新步骤。
5. 验证普通 Agent 看不到 `runtime_*` 工具，宿主写策略拒绝仍生效。
6. 核对同 root 单进程共享 8 个 active run、run/resume 准入和 status 分页（`limit` 1–100、`offset` 0–10000）；默认仅清理超过最新 100 条的终态，保护 `running/interrupted`。
7. `pwsh` 显式 `run_in_background:true` 应在预检拒绝；自动转后台不能放行下游，须从 `runtime_result` 取 `jobId` 并用原生 `job_output/job_kill` 收集或停止。

边界：以上是验收步骤，不是已通过记录。自动化测试范围见[验证范围](<validation.md>)，通过与跳过状态以本次 `npm run check` 实际输出为准。真实 fork kill + 重启、真实 ToolRuntime 嵌套 deny、真实 pwsh 工具与实际 pwsh 进程属于不同证据层次；pwsh 测试的 shell bridge 不是实际 sandbox。真实模型、桌面 UI 与实际沙箱仍未验收。

## 隔离真实验收的前置条件

当前只读核查不运行以下真实验收；未有对应证据的项目保持 pending。当前尚无已确认的隔离目标；研发授权不等于操作日常 DSH 的安装、重启或中断授权。涉及环境准备和生命周期操作时先确认专用目标，不自动安装、重启或启动服务器，不以日常 DSH 配置、当前会话权限或组件夹具代替隔离环境。

- 确定同一候选 tgz 的包名、版本、SHA-256，以及精确宿主、Cordis、Node、模型 provider/model ID 和权限配置。候选内容变化须重建报告，旧版本或另一个哈希的 pass 不可移用。
- 操作者确认独立的 profile/配置、DSH 数据、运行记录、工作区、会话与副作用记录；不得指向日常 DSH 目录。临时安装 smoke 设置的 DSH_HOME 和 XIAOHE_RUNTIME_DIR 不证明真实桌面启动已隔离，仍需核对目标宿主实际使用的目录。
- 在实际隔离目标 GUI 验证派生预设、默认预设和普通 Agent 可见性；不以启动另一个网页服务器冒充桌面验收。只有可被中断、卸载及重启的专用宿主，才可执行第 4 步和生命周期用例；不操作日常 DSH。
- 使用真实 OS sandbox provider 分别验证 read-only、workspace-write 和审批拒绝；准备独立的工作区外探针，核对拒绝路径无副作用。工具 hook deny、full-access PTC 夹具和 shell bridge 均不能作为 OS 沙箱证据。
- 模型和所需授权由操作者在隔离环境配置；核查仅需精确模型 ID、可用性及非敏感配置标识，不读取或复制 token。真实条件不可用时仅准备账本/实验 manifest，不生成成功样本。
- 每项保存受控的时间、调用关系、实际文件/副作用计数及清理结果，用不含路径的 evidenceId 关联。未知副作用必须人工核对，不从 unknown 推断未执行，不从取消回执推断已退出。

最小证据应能回答“哪个候选、在哪个独立环境、用什么模型/权限、何时执行、观察到哪些副作用、是否清理”。本地存在候选、依赖版本一致或组件测试通过，都不足以将真实十二项改为 pass。上游依赖安全告警单独评估，见[宿主兼容性](<host-compatibility.md#依赖安全告警>)。

## 候选绑定的验收记录

自动化组件测试不是以下真实环境验收。先完成候选打包，使用脚本所属包的实际版本定位同一候选，再初始化全部 pending 的记录：

~~~powershell
$version = node -p "require('./package.json').version"
$candidate = "artifacts/candidate/feng0531-dsh-execution-bus-$version.tgz"
node scripts/acceptance-report.mjs init --candidate $candidate > artifacts/acceptance.json
node scripts/acceptance-report.mjs check --candidate $candidate --report artifacts/acceptance.json
~~~

init 只计算候选字节 SHA-256 并输出模板，不安装或重启宿主，也不自动验证 tgz 的内容。候选身份应先通过上面的打包及安装检查；报告里的 packageName/version 取自运行脚本所属包。

逐项真实执行后，在本地报告填入环境和 assertions，pass 必须有带时区的起止时间、全部 true 的断言，以及不含路径的 evidenceId（对应受控保存的日志/副作用记录）。包含 PTC 链、权限/沙箱、审批拒绝、取消、async、卸载、整宿主重启、unknown 人工核对、Job 清理和真实模型十二项；桌面操作在实际目标 GUI 中验证。

check 的退出码：0 表示操作者报告完整且与候选匹配；2 表示仍有 pending/skipped/fail 或缺环境；1 表示报告非法、候选不匹配或读取失败。默认全 pending 得到 2 是正常的未验收状态，不能改成 pass 来消除退出码。工具只是人工证据账本，不认证断言真实性，不是发布授权或收益证明。输入报告 ≤1MiB、候选 ≤32MiB；不上传网络。日志证据单独保管，不把命令、路径或凭据塞进报告字段。

正式安装包也携带这些离线工具：在安装包目录运行上述 node 命令，或在源码仓库用对应 npm 脚本。故障处理见[运行状态与故障处置](<OPERATIONS.md>)。

## 本地会话指标

`npm run metrics:sessions -- --sessions <日志目录> --preset xiao-he-runtime --json` 仅读取本地会话日志，不发送网络遥测。输出包含 runtime 工具请求、观测运行状态与步骤 attempts；同一会话内按运行/步骤去重。取消和恢复仅计请求，缺失结果不推测成功；跨会话重复出现的运行分别计数。默认不输出业务输入、命令、路径或结果正文，但哈希标识不等于匿名。需要支持 zstd 的 Node 构建（22.15+ 或 23.8+）；坏日志和不支持的事件会报告诊断，不静默当作零使用。

## 小范围收益对照试验（待真实 pilot）

- 固定任务、输入快照、成功判据、宿主与模型版本、权限及资源预算；两组使用相同环境与重复次数，保留失败和人工中止样本。
- 对照组使用原生工具与原生并行能力，而不只是串行调用；实验组使用运行时 DAG。记录计划准备与恢复成本，避免把不同并发额度当成运行时收益。
- 分别记录任务成功率、模型调用次数、人工介入次数和端到端耗时；按同一口径比较，不只报告成功样本或单次最快耗时。
- 在相同故障点中断并恢复，核对实际副作用计数、已保存步骤重放数、未知副作用及停止后的新增步骤数；`unknown` 不能计作未发生副作用。
- 未完成真实 pilot 前不写收益数字，不从自动化契约测试推导模型效率、成本或生产可靠性结论。

### 预登记候选与实验配置

建议使用一个精确模型，对只读（read-only）、混合读写（mixed）、故障恢复（recovery）三类各选两个任务，每个重复三次、两臂合计 36 次尝试（18 对）；这不是工具强制样本量，最终方案须事先固定。复用现有统计工具，manifest 仅补充配置与字节绑定：

~~~powershell
$version = node -p "require('./package.json').version"
$candidate = "artifacts/candidate/feng0531-dsh-execution-bus-$version.tgz"
node scripts/pilot-manifest.mjs init --candidate $candidate > artifacts/pilot-manifest.json
node scripts/pilot-manifest.mjs check --candidate $candidate --manifest artifacts/pilot-manifest.json
# 仅在真实采集后附加实际观察文件：
node scripts/pilot-manifest.mjs check --candidate $candidate --manifest artifacts/pilot-manifest.json --observations artifacts/observations.json
~~~

init 输出 pending 模板，不执行任务；pairs 初始为 null，不自动生成 18 对或成功数据。操作者在本地填入精确 hostId/modelId、sandbox、executionMode（per-call 或 persistent-in-memory）、两臂 presentation（native 或 ptc）、相同并发额度（1–4）、交替顺序及 firstArm/pairs；在外部预登记输入快照、任务计划、成功判据、决策阈值和模型设置的 SHA-256 与 registeredAt。模式写入 manifest 不证明对应模式已实际验收。

check 校验候选字节、声明结构及观察文件摘要绑定，输出仅保留标识哈希，不输出原始模型/宿主 ID、正文、命令或路径。它不认证真实执行、时间或配对环境；evidenceReady 始终为 false，完整 manifest 或退出码 0 都不是收益证据。真实条件不可用时保留待采集状态，不为满足样本数伪造观察。

### 采集尝试记录与生成对照报告

每次任务尝试写一条 JSON/JSONL（不是每个工具调用一条）。arm 用 native/runtime；pairId 为相同任务/模型/设置的一对尝试的本地编号，跨重复使用不同编号；不得只采成功样本：

~~~json
{"version":1,"arm":"native","outcome":"succeeded","pairId":"task-a-repeat-1","taskClass":"read-only","metrics":{"wallTimeMs":1200,"modelTurns":3,"toolRequests":4,"toolSuccesses":4,"humanInterventions":0}}
~~~

~~~powershell
node scripts/pilot-report.mjs collect --input artifacts/attempts.jsonl > artifacts/observations.json
node scripts/pilot-report.mjs report --input artifacts/observations.json --json > artifacts/pilot-summary.json
node scripts/pilot-report.mjs report --input artifacts/observations.json
~~~

outcome 支持 succeeded/failed/aborted/cancelled/interrupted/unknown/running，不能把 runtime succeeded 直接当任务成功。taskClass 支持 read-only/mixed/maintenance/recovery；指标还可填 promptTokens、completionTokens、pollingRequests、retryRequests、recoveryMs。缺失或非法数值保持 null，不当成零；toolRequests 与 toolSuccesses 分开。报告保留各 outcome、缺失覆盖与异常输入计数；仅唯一且两边成功的配对计算差值，同时披露失败配对，不从成功子集推断总体收益。pairKey 是哈希化的本地配对标识，不等于匿名；请自行确认配对环境一致。

### 组件容量与长尾基准

先 npm run build，或使用已校验的包内 dist。基准不自动重建，不调用模型，不碰已有运行目录，只用可清理的系统临时目录：

~~~powershell
node scripts/benchmark-runtime.mjs --suite dag --iterations 3 --concurrency 2,4 > artifacts/dag-benchmark.json
node scripts/benchmark-runtime.mjs --suite capacity --sizes 1000,10000 --interrupted 0,0.5,0.9 --iterations 1 > artifacts/capacity-benchmark.json
~~~

默认只跑短 DAG；容量基准需显式选择。每个操作独立生成历史，准备时间不计入操作耗时；recoverable 比例内包含已有 interrupted 和失联 running，分别测 list、warm-list、prune、RuntimeService 启动。list 是新 RunStore 实例的首次元数据读取，warm-list 是同实例第二次读取，两者都不是清空 OS 文件缓存后的冷读；两者是同一历史的配对样本，不是独立重复。iterations 才是独立生成历史的重复数；单次示例不能支撑稳定收益判断。setImmediate 探针包含同步阻塞和调度基线，不是 CPU 时间或独立归因。大规模测试会写入大量临时文件，应确认磁盘空间并在非繁忙时间运行。

DAG 对照的 native 是相同并发额度的可补位 Promise 调度，运行时使用真实执行器、磁盘检查点和批次屏障；契约不同会产生额外等待，不能把测试数字宣传成模型节省。先按实际负载制定延迟预算，再决定索引、增量清理、结果制品或调度协议升级；不通过提高并发额度制造虚假收益。
