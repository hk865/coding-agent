# Event Sink Adapter

- **职责**：实现 EventSinkPort 并分发只读运行事件。
- **非职责**：不修改或回写 Runtime 状态。
- **允许依赖**：EventSinkPort。
- **禁止依赖**：Reducer 和 Provider 实现。
- **负责里程碑**：M2
- **当前状态**：已保留职责化 EventSink 适配器扩展入口；当前具体 best-effort 实现位于 logging 和 trace，尚无额外通用适配器。
