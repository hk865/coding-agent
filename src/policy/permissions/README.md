# Permission Policy

- **职责**：根据工具、参数和 workspace 策略计算权限结论。
- **非职责**：不依赖模型自行保证安全。
- **允许依赖**：工具声明、调用参数、配置。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3 已实现路径规范化、敏感资源拒绝和 read/edit/shell 的 allow/deny/ask 决策，并通过工具链集成测试。
