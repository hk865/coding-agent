# Observability

- **职责**：只读记录事件、trace 和日志。
- **非职责**：不能修改 RunState 或控制终止状态。
- **允许依赖**：EventSinkPort 与日志后端。
- **禁止依赖**：Core Runtime 内部。
- **负责里程碑**：M2
- **当前状态**：M2 已实现脱敏 StructuredEventLogger 和 InMemoryTraceSink；Metrics 保持 MVP 后延期。
