# Core Runtime

- **职责**：组织 RunState、Event、Reducer、Limit、Cancellation 与 Loop。
- **非职责**：不直接调用厂商 SDK 或具体工具。
- **允许依赖**：Core Port、Core context 与 Core hooks。
- **禁止依赖**：任何外层 Adapter。
- **负责里程碑**：M1 定义 State/Event；M2 实现 Reducer/Limit/Cancellation/Loop。
- **当前状态**：截至 M4，State/Event、Reducer、Limits、Cancellation、RuntimeRunner、EventDelivery、Checkpointing 和 Recovery 均已实现并通过门禁。
