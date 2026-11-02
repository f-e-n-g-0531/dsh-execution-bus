# 宿主兼容性

目标宿主：DSH **0.2.1-rc.5**、Cordis ~4.0.5、include ~1.0.10、Node ≥22；锁定依赖实际解析为 Cordis 4.0.5、include 1.0.10。DSH peer 与测试依赖均精确锁定 rc.5，不宣称兼容 rc.2、rc.3、rc.4 或未来版本。

## 依赖的宿主契约

- 工具注册与执行：`ctx.tools.register` / `ctx.tools.execute`；运行时用父工具调用的 `exec.token` 作为 `parent`，沿用宿主权限、工作目录与沙箱。
- 预设派生：通过 `agentPresets.readDocument("ptc")` 读取公开声明，再用 `register` 注册派生预设；不修改默认预设或全局工具。
- 模式提示：`ctx.systemPrompt.section` 追加运行时说明。
- 同步 run/resume 传播外层 signal；`async:true` 成功接收后脱离外层信号，但仍在宿主进程内。取消不保证不合作工具退出。
- `pwsh` 前台返回须检查退出码、中止/超时与沙箱失败；显式 `run_in_background:true` 被运行时预检拒绝。自动转后台只表示已生成 Job，运行时标为失败/`unknown` 并保留 `jobId`，用宿主原生 `job_output/job_kill` 收集或停止。

## rc.5 兼容核验

- rc.2 与 rc.5 的 tools、scope、preset-registry、agent-tool-presentation、system-prompt 共8份相关公开类型声明相同；源码无需改变权限传递或执行语义。声明一致不代替执行测试。
- 构建及真实 ToolRuntime、Node PTC 子进程、文件 DAG、命令回执、展示与预设隔离测试使用 rc.5 包；全量结果以本次 check 和标签 CI 输出为准。生产候选安装另外检查实际解析出的四项 DSH peer 均为 rc.5，不能只改版本字符串却运行旧依赖。
- 当前 PTC 集成夹具显式使用 danger-full-access，不覆盖 rc.5 的只读/工作区 OS 沙箱 confine 路径；per-call 默认模式不代表已验证 persistent 模式。没有模型调用、桌面安装或重启。

## 依赖安全告警

2026-11-02 的 npm audit 对该依赖树返回 **33 个受影响包节点（30 high、3 moderate）**，根源为宿主依赖中的 undici 8.11.2、zod 4.4.3 的已收录告警及传播计数，不是33个独立漏洞。项目未打包第三方依赖，但生产安装会通过宿主 peer 解析相关依赖。功能兼容通过不表示这些告警已消除；本版不使用 force、legacy-peer-deps 或 overrides 绕过 rc.5 的精确依赖要求。涉及不可信网络/输入的部署需结合上游修复评估后再启用；重新审计以当时数据库为准。

## 已知边界

- 运行时在宿主进程内执行；不依赖私有 PTC 中断字符串，也不保证跨宿主版本。
- 计划步骤使用宿主工具自身 schema；宿主升级导致工具参数变化时需同步计划示例。
- 运行记录为本地文件，不参与宿主会话日志恢复。

升级宿主后至少重跑 `npm run check` 与真实 ToolRuntime 集成测试；记录实际通过/失败/跳过，不能用测试文件存在代替执行证据。真实 pwsh 工具 + 实际 pwsh 进程测试使用 shell bridge，不等于实际 sandbox 验收；桌面 UI、模型与实际沙箱仍未验收。
