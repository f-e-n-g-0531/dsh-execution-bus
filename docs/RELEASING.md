# 测试与发布流程

参考 dsh-vcs 的标签 CI 与联合发布流程，针对纯后端执行总线适配。没有复制 SVN、Monaco 或浏览器 layout 检查，因为本项目没有这些依赖和前端。

## 触发策略

普通分支 push 和 pull_request 不触发 CI。仅 vX.Y.Z 标签 push 和手动 workflow_dispatch 触发 CI；Windows/Ubuntu × Node 22/24 四项矩阵运行相同的构建、测试、包白名单、候选打包和生产依赖隔离安装。手动分支 CI 不能替代正式发布所需的同标签 push CI。

## 本地验证

依次运行 npm ci --include=dev --ignore-scripts、npm run check、npm run verify:package、npm run pack:candidate、npm run test:install。test:install 默认新打包，也允许传入一个本地 tgz。安装目录在系统临时目录中，结束后清理，不操作用户 DSH 配置。

每个版本必须有独立中文发布说明 docs/releases/X.Y.Z.md，注明实际模型/桌面/跨重启等未验证项。package.json、package-lock.json 根版本及标签必须一致。不移动已有标签。

## 发布门禁

用户已授权 0.1.0 正式发布，并确认沿用 dsh-vcs 的非商业源码公开许可证。该许可不是 OSI 开源许可证，限制商业项目内部使用与有偿交付，具体以 LICENSE 为准。后续发布仍需明确授权与工作流确认，不表示实际模型验收通过。

准备正式发布前：由用户明确授权；确定 LICENSE 与包 license 字段；检查公开材料、第三方许可和敏感信息；更新版本、锁文件与发布说明；提交并推送已批准的版本标签；等待四矩阵通过。

从 main 手动运行 Publish GitHub and npm，输入已存在标签及确认词 publish-execution-bus。推荐为 npm-release environment 配置必须审批的维护者及适当分支限制，并配置 NPM_AUTOMATION_TOKEN。仓库环境审批和 token 均需要维护者配置，本次没有配置远端。

工作流重新检查标签版本与许可证，运行本地检查，生成候选，查询该精确标签/提交的最新 push CI 为 success，下载四个矩阵候选并逐字节核对。然后隔离安装同一候选、保留制品，仅 npm 上传步骤取得凭据。npm 公开元数据 integrity 与实际下载字节必须一致，才创建 GitHub Release；附件是同一个 tgz 与 SHA256SUMS.txt。不自动覆盖已有 Release。

npm 与 GitHub 不是原子发布。如果上传后公开包 404，不盲目重传；先只读对账，再重跑原工作流。已有 npm 同版本必须 integrity 相同才跳过上传；不匹配立即停止。发布过程没有自动重试上传，公开可见性最多查询十次。

## 验证边界

本地 Windows/Node 24 的脚本验证不等于 GitHub 四平台已成功。远端工作流、token、environment 审批、上传和两端公开包核验在执行前都属于未验证。CI 中的脚本模型适配器不是实际模型评测，包入口夹具不是桌面安装验收。发布不自动安装或重启 DSH。
