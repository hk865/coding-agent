# OpenAI Provider

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

计划使用官方 SDK 和 Responses API 实现一个 ModelClientPort Adapter。

本模块负责鉴权、请求映射和厂商事件转换；不负责 Runtime 重试策略、Tool 执行、权限或状态推进。

## 当前状态

已实现官方 SDK Responses API
Adapter、流式文本/ToolCall/usage/错误/取消映射；真实网络 smoke 尚待授权和记录。

## 已实现

- 作为多 Provider 架构中的 `openai` Adapter，由 Registry/Composition 显式选择。
- 把 ModelRequest 映射为 Responses API 输入、工具 schema 和输出上限。
- 把文本、ToolCall 参数、usage、completed、truncated、error 和 cancelled 映射为 ModelEvent。
- 把 AbortSignal 传递到网络边界，并对厂商错误进行稳定分类。
- 使用本地 fixture 验证协议，真实网络仅作受控人工确认。

## 前置条件

- 通过配置和环境安全注入 API 凭据。
- 明确 MVP 基线模型，但不把模型名硬编码进 Core。

## 验收条件

- 通过 ModelClientPort 共享 contract 和模型流集成测试。
- 流式 ToolCall 参数顺序、usage 和终止事件与协议一致。
- 取消能及时结束请求，日志不泄漏 Authorization 或响应敏感字段。
