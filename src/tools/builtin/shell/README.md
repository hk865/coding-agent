# Shell Tool

- **职责**：在 process sandbox 中执行受控命令。
- **非职责**：不允许无 sandbox 的降级执行。
- **允许依赖**：Tool schema、Permission、Approval、Sandbox process。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 ProcessSandbox 命令工具及退出、超时、取消和输出截断映射；无隔离能力时不会静默降级。
