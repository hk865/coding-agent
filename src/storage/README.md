# Storage Adapters

- **职责**：实现 SessionStorePort 和 CheckpointStorePort。
- **非职责**：不拥有 Core Session/Checkpoint 契约。
- **允许依赖**：对应 Store Port 与存储驱动。
- **禁止依赖**：Core Runtime 内部。
- **负责里程碑**：M4
- **当前状态**：M4 已实现 InMemoryStores、SqliteStores 和 required
  SessionEventSink，并通过共享 contract、集成与跨进程恢复测试。
