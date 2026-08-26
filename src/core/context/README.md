# Context

- **职责**：把受控信息组装成厂商无关 ModelRequest。
- **非职责**：不执行工具、保存 Session 或直接调用模型。
- **允许依赖**：Core 值类型与 Provider Port。
- **禁止依赖**：外层 Adapter 实现。
- **负责里程碑**：M1–M2
- **当前状态**：截至 M4，Context 值类型、确定性 Builder 和 token
  SelectionPolicy 已实现并通过单元/集成测试；Compactor 延期到 MVP 后。
