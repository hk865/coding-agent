# Core Ports

- **职责**：保存 Core 所需能力的最窄厂商无关接口。
- **非职责**：不放具体 Adapter 或重复领域契约。
- **允许依赖**：Core 自有值类型。
- **禁止依赖**：外层实现细节。
- **负责里程碑**：M1、M4、M5（按叶子）
- **当前状态**：截至 M4，ModelClient、ToolExecutor、EventSink、SessionStore 和 CheckpointStore
  Port 已实现；SkillProvider 与 MemoryProvider Port 计划在 M5 实现。
