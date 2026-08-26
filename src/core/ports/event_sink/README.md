# Event Sink Port

- **职责**：定义 best_effort/required 两级只读 Runtime 事件消费边界。
- **非职责**：不能修改 RunState、返回控制结果或递归触发 Event。
- **允许依赖**：Core AgentEvent。
- **禁止依赖**：observability 实现细节。
- **负责里程碑**：M1-05；排序投递与失败处置在 M2 实现。
- **当前状态**：CONTRACT + tested。
