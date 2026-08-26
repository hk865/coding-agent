# Approval Policy

- **职责**：决定 Allow/Deny/Ask，并定义 ApprovalRequester 边界。
- **非职责**：不执行工具或提供 CLI UI。
- **允许依赖**：Permission 结果与工具调用。
- **禁止依赖**：Core Runtime 状态。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 ask 决策的操作指纹、预览、超时、取消和一次性审批协调；真实 CLI
  ApprovalRequester 计划在 M5 实现。
