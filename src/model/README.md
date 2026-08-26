# Model Adapters

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

承载模型厂商 Adapter，把外部流式协议映射为 ModelClientPort。

厂商 SDK 类型、鉴权和网络错误只能存在于 Adapter 层；不得泄漏进 Core，也不得直接修改 RunState。

## 当前状态

OpenAI Responses 与 DeepSeek Chat Completions Adapter、共享协议支持和静态 Provider
Registry 已实现；确定性测试仍使用 Fake/fixture，真实网络只做受控 smoke。

## 已实现

- 实现静态 Provider Registry，以及 OpenAI 与 DeepSeek 两个真实 Adapter。
- Provider 由 App 显式选择；新增厂商不修改 Core/Runtime。
- 复用 ModelClientPort 的请求、事件序列、用量、错误和取消语义。
- 提供确定性 fixture/mock contract，真实网络只用于少量人工 smoke。

## 前置条件

- 模型凭据、厂商和模型选型由 M5 配置与 Composition 管理。
- Provider 不承担 Runtime 重试、Tool 执行或终态决策。

## 验收条件

- 流式文本与 ToolCall 能完整映射到版本化 ModelEvent。
- usage、截断、可重试错误、取消和协议异常有 contract 测试。
- Core 中不存在厂商 SDK 类型或依赖。
