# Tool Dispatcher

- **职责**：实现 ToolExecutorPort，并组合 Registry→Permission→Approval→Sandbox→Tool。
- **非职责**：不允许任何工具绕过强制链。
- **允许依赖**：ToolExecutorPort、Registry、Policy、Sandbox、builtin。
- **禁止依赖**：Core Runtime 内部状态。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 Registry → Permission → Approval →
  Handler 强制链，并验证 deny、审批、取消和结果关联。
