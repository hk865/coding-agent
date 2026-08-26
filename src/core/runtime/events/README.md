# Runtime Events

- **职责**：拥有 AgentEvent、EventMeta、strict schema 和相对 RunState 的转换合法性校验。
- **非职责**：不执行行为、不修改 State，也不等同于 ModelEvent 或 Hook。
- **允许依赖**：Core state、context 和 Core Ports 的值类型。
- **禁止依赖**：厂商事件、Provider、Tool 或 Storage 实现。
- **负责里程碑**：M1-01；事件应用 Reducer 在 M2 实现。
- **当前状态**：`△ CONTRACT`，覆盖身份、连续 sequence、派生阶段、operation 匹配和终止不可变性。
