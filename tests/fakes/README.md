# Fakes

- **职责**：保存实现 Core Port 的可脚本化、可计数、可取消测试替身。
- **非职责**：不复制真实 Provider、Dispatcher、Policy、Sandbox 或 Storage。
- **允许依赖**：Core Port 与 tests 内显式 gate。
- **禁止依赖**：真实 Adapter、网络、真实 sleep 和生产工作区。
- **负责里程碑**：M1-06
- **当前状态**：FakeModelClient、FakeToolExecutor、EventCollector、ControllableGate 已实现并通过单元测试。
