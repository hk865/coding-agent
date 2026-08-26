# Checkpoint Store Port

- **职责**：定义可恢复运行快照的保存和读取边界。
- **非职责**：不定义 SQLite schema。
- **允许依赖**：Core RunState 快照值。
- **禁止依赖**：storage 实现细节。
- **负责里程碑**：M4
- **当前状态**：M4 已实现 checkpoint
  schema、checksum、稳定恢复模式和 CheckpointStorePort，并由内存/SQLite 适配器共享验证。
