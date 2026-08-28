# Workspace Sandbox

- **职责**：规范化并限制文件能力只能作用于受控 workspace。
- **非职责**：不决定用户是否批准某次修改。
- **允许依赖**：Linux 文件系统能力与配置。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：已实现 workspace 内 read/write/create/delete/patch、路径限制、symlink 防护、内容级 edit 并发保护；revision 优先使用受限 Git
  porcelain 主线，非 Git 目录回退稀疏元数据。Agent 维护 Session 路径覆盖树与一个可替换的 workspace 基线，check 支持 session/workspace 对账，strict 模式在风险操作审批前拒绝外部漂移。
