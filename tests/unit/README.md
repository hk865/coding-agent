# Unit Tests

- **职责**：验证纯逻辑、状态转换、局部不变量和确定性测试替身。
- **非职责**：不伪装跨模块集成覆盖。
- **允许依赖**：被测模块、tests/helpers 与 tests/fakes。
- **禁止依赖**：真实网络、真实 sleep 和生产存储。
- **负责里程碑**：随里程碑增量
- **当前状态**：M0 helper、M1 ContextBuilder 与 Fakes 单元测试已实现。
