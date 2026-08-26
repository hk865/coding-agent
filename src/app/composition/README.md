# Composition

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

作为 Composition Root 创建并连接 Core Port 与具体 Adapter，统一管理进程级资源。

本目录只做依赖装配和生命周期管理，不复制 Context、Runtime、Tool 或 Storage 的业务规则。

## 当前状态

截至 M4，本目录只有本 README；当前装配示例仅存在于集成测试和 E2E 测试。

## M5 计划

- 解析稳定配置，通过 Provider Registry 创建显式选择的 OpenAI/DeepSeek
  ModelClient，并创建 Stores、EventSinks、ToolRegistry、Policy 和 Sandbox。
- 创建 RuntimeRunner、RecoveryCoordinator 与 CLI 所需服务。
- 明确数据库、进程沙箱、信号监听器和日志 sink 的关闭顺序。
- 为新会话与恢复会话提供显式装配路径。

## 前置条件

- M5 Provider Registry、OpenAI/DeepSeek、SkillProvider、MemoryProvider 与配置实现可注入。
- M3/M4 Adapter 的创建参数和资源所有权明确。

## 验收条件

- 生产装配只依赖 public-api 或明确的稳定 Adapter 入口。
- 新建与恢复流程都能通过 CLI smoke。
- 初始化中途失败会释放已经创建的资源。
