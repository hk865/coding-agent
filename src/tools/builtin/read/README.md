# Read Tool

- **职责**：在 workspace 边界内读取允许的文件。
- **非职责**：不修改文件或执行命令。
- **允许依赖**：Tool schema、Permission、Sandbox workspace。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3 已实现受 workspace 边界和返回量限制的文件/目录读取，并通过工具安全链集成测试。
