# Tool System

- **职责**：验证、注册并经强制安全链执行 Coding Tool。
- **非职责**：不拥有 Core ToolCall/ToolResult 契约。
- **允许依赖**：ToolExecutorPort、Policy、Sandbox。
- **禁止依赖**：Core Runtime 状态。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 Tool
  schema、Registry、Dispatcher、安全策略链和 read/edit/shell 内置工具，并通过集成测试。
