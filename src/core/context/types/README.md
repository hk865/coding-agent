# Context Types

- **职责**：拥有 JSON、User/AssistantMessage、ContextFragment、SkillContext、MemoryItem 及 strict
  schema。
- **非职责**：不获取、筛选、执行或持久化这些值。
- **允许依赖**：Zod 运行时 schema。
- **禁止依赖**：Provider、Storage、Tool 和 IO。
- **负责里程碑**：M1-04；Skill/Memory Provider Port 在 M5 冻结。
- **当前状态**：`△ CONTRACT`，所有值可 JSON round-trip，未知字段和非 JSON 值被拒绝。
