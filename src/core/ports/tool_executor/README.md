# Tool Executor Port

- **职责**：拥有 ToolCall、ToolResult、ToolOutputPart、ToolEffects、ToolError、ToolExecutorPort 和 callId 校验。
- **非职责**：不实现 Registry、Dispatcher、Permission、Approval、Sandbox 或具体工具。
- **允许依赖**：Core JSON 值类型。
- **禁止依赖**：`tools`、`policy`、`sandbox` 具体实现。
- **负责里程碑**：M1-03；真实 Dispatcher 与 read/edit/shell 在 M3 实现。
- **当前状态**：`△ CONTRACT`，success/error/cancelled 和 possible side effect 语义已通过 contract
  test。
