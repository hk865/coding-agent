# Reducer

- **职责**：以纯函数执行 State + Event -> New State。
- **非职责**：不访问时间、随机数、网络或文件系统。
- **允许依赖**：State 与 Event。
- **禁止依赖**：所有 Adapter 和 IO。
- **负责里程碑**：M2
- **当前状态**：M2 已实现 AgentEvent 到 RunState 的纯函数归约、转换校验和状态不变量检查。
