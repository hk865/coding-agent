# Runtime State

- **职责**：拥有 Run、Turn、RunState、RunStatus、Outcome、Pause、strict
  schema、初始工厂、状态不变量和阶段派生。
- **非职责**：不执行完整 Reducer、Loop 或外部副作用。
- **允许依赖**：Core context 值类型和 ToolExecutorPort 值类型。
- **禁止依赖**：Adapter、IO、AbortSignal、厂商 SDK。
- **负责里程碑**：M1-01；Reducer 在 M2 实现。
- **当前状态**：`△ CONTRACT`，contract test 已覆盖初始快照、JSON、非法组合和派生阶段。
