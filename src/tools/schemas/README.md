# Tool Schemas

- **职责**：保存具体工具参数 schema 和运行时校验器。
- **非职责**：不重复定义 Core ToolCall/ToolResult。
- **允许依赖**：Zod 与工具实现类型。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 ToolDefinition、ToolHandler、效果分类、sandbox
  capability 和操作摘要 schema。
