# Contract Tests

- **职责**：验证 Port 的 Fake 与真实 Adapter 遵守同一契约。
- **非职责**：不以 Fake 私有行为替代 Port 契约。
- **允许依赖**：Core Port、schema 与验证器。
- **禁止依赖**：无关内部实现。
- **负责里程碑**：M1 起
- **当前状态**：M1 State/Event、Model、Tool、Hook/EventSink 契约测试已实现。
