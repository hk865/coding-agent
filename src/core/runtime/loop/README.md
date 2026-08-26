# Runtime Loop

- **职责**：驱动模型事件和工具结果形成受控的最小循环。
- **非职责**：不实现 Provider、Tool 或持久化。
- **允许依赖**：Core Port、Reducer、Limit、Cancellation、Context、Hook。
- **禁止依赖**：model、tools、storage、policy、sandbox。
- **负责里程碑**：M2
- **当前状态**：M2 主循环与模型流消费已实现；M3 工具安全链和 M4 持久化/恢复组合已通过集成与跨进程测试。
