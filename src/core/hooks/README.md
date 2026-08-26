# Hooks

- **职责**：提供 Runtime 内受控扩展点的协议、注册和执行。
- **非职责**：不替代 Event、Permission、Approval、Limit、Sandbox 或 Reducer。
- **允许依赖**：Core 自有类型。
- **禁止依赖**：具体 Adapter 业务实现。
- **负责里程碑**：M1 冻结 protocol；M2 实现 registry/executor。
- **当前状态**：截至 M4，Hook protocol、Registry 和 Executor 均已实现并通过契约与 Runtime 集成测试。
