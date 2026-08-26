# Cancellation

- **职责**：统一用户取消、超时和受控终止信号。
- **非职责**：不把任意异常伪装成取消。
- **允许依赖**：标准 AbortSignal 与 Core 类型。
- **禁止依赖**：具体 Provider 或 CLI。
- **负责里程碑**：M2
- **当前状态**：M2 已实现统一 AbortSignal、幂等取消原因和 AbortError 识别，并通过 Runtime 取消测试。
