# Context Selection Policy

- **职责**：决定上下文条目的优先级、可见性与预算内选择。
- **非职责**：不执行权限授权或 OS 隔离。
- **允许依赖**：Context types。
- **禁止依赖**：具体 Provider 和 Tool。
- **负责里程碑**：M2
- **当前状态**：M2 已实现并验证 token 估算、稳定裁剪顺序、transcript 成组保护和 Hook 修改后的预算复核。
