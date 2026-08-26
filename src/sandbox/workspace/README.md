# Workspace Sandbox

- **职责**：规范化并限制文件能力只能作用于受控 workspace。
- **非职责**：不决定用户是否批准某次修改。
- **允许依赖**：Linux 文件系统能力与配置。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 workspace 内 read/write/create/delete/patch、路径限制、symlink 防护、并发保护和 revision 更新。
