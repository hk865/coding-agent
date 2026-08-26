# Core

- **职责**：保存厂商无关的运行规则、值类型与 Port。
- **非职责**：不实现网络、文件系统、数据库或 OS 沙箱。
- **允许依赖**：Core 内部模块与标准库。
- **禁止依赖**：app、model、tools、storage、policy、sandbox、observability、skills、memory、mcp。
- **负责里程碑**：M1–M2
- **当前状态**：截至 M4，M1 Core 契约、M2 Runtime 闭环和 M4 Session/Checkpoint/Recovery
  Core 模块均已实现并通过门禁；Skill/Memory Port 计划在 M5 实现，Compactor 延期。
