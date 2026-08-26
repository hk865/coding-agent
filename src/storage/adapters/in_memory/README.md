# In-memory Store

- **职责**：提供确定性的 Store Port 测试/进程内实现。
- **非职责**：不提供跨进程持久化保证。
- **允许依赖**：Session/Checkpoint Store Port。
- **禁止依赖**：Core Runtime 内部。
- **负责里程碑**：M4
- **当前状态**：M4 已实现 SessionStorePort 与 CheckpointStorePort 的严格内存适配器，覆盖 revision、position、分页、幂等和 checksum 语义。
