# check tool

check 对账 Agent 内存中的变更基线：

- session 只复核本次运行已读/已改/命令影响过的路径；
- workspace 使用 Git porcelain 主线；非 Git 目录回退到稀疏元数据快照；
- 工具只报告漂移并推进观察基线，不修改工作区文件。

路径能力和敏感资源拒绝仍由 WorkspaceSandbox 与 PermissionPolicy 强制。
