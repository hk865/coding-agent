# Hook Executor

- **职责**：受控执行 Hook，归一化超时、异常和 HookResult。
- **非职责**：不绕过 ToolExecutorPort 内部安全链。
- **允许依赖**：Hook protocol、registry、Cancellation。
- **禁止依赖**：Policy/Sandbox 具体实现。
- **负责里程碑**：M2
- **当前状态**：M2 已实现并验证顺序执行、超时、取消、异常归一化、modify 合并和短路决策。
