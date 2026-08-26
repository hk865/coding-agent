# Model Client Port

- **职责**：拥有 ModelRequest、ModelMessage、ModelEvent、ModelUsage、ModelClientPort、strict
  schema 和流协议校验。
- **非职责**：不出现 OpenAI 等厂商类型，不决定 Run 终止状态。
- **允许依赖**：Core context 与 ToolExecutorPort 值类型。
- **禁止依赖**：`model/providers` 实现和网络 SDK。
- **负责里程碑**：M1-02；真实 Provider 在 M5 实现。
- **当前状态**：`△ CONTRACT`，final/tool/usage/error/cancel 流协议已冻结并通过 contract test。
