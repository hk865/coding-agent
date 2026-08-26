# Policy

- **职责**：决定权限和审批，不直接执行副作用。
- **非职责**：不等同于 OS sandbox。
- **允许依赖**：工具声明、调用信息和用户策略。
- **禁止依赖**：Core Runtime 状态。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 PermissionPolicy 与 ApprovalCoordinator；内容级 Guardrails 保持 MVP 后延期。
