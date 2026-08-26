# SQLite Store

- **职责**：以事务方式持久化 Session 和 Checkpoint。
- **非职责**：不拥有 Core Store 契约，也不把 SQL、事务或驱动类型泄漏到 Core。
- **允许依赖**：Session/Checkpoint Store Port 与 SQLite 驱动。
- **禁止依赖**：Core Runtime 内部。
- **负责里程碑**：M4
- **当前状态**：M4 已使用 Node 内置 SQLite 实现事务化 Session/Checkpoint 持久化，并通过共享 contract 与跨进程恢复 E2E。
