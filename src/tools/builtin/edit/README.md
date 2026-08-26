# Edit Tool

- **职责**：在审批和 workspace 边界内执行可审计编辑。
- **非职责**：不执行 shell 命令。
- **允许依赖**：Tool schema、Permission、Approval、Sandbox workspace。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 write/replace/delete/patch 编辑模式，所有文件副作用经 WorkspaceSandbox 执行并返回可审计 effects。
