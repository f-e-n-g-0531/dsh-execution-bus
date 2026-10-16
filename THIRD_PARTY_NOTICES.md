# 第三方说明

本包没有捆绑 DSH、Cordis、TypeScript、测试依赖或宿主源码快照。DSH 与 Cordis 作为宿主 peer 使用，其独立包分别受原许可证约束，本项目非商业许可证不限制第三方已授予的权利。开发依赖不进入本项目 tgz。js-yaml 为 MIT 许可的独立运行依赖，由包管理器按声明安装，不捆绑进 tgz；其源码和许可见 https://github.com/nodeca/js-yaml ，本项目许可不限制其原有权利。

CI 与发布组织方式参考 dsh-vcs，并按本项目执行能力重新实现；本包不含 Monaco、React 或 SVN 实现。
