# DeepSeek Provider

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

计划使用 DeepSeek 官方 endpoint 的 OpenAI 兼容 Chat Completions 协议，实现独立的 ModelClientPort
Adapter。

本模块负责 DeepSeek 鉴权、请求映射、SSE
ToolCall/usage/错误/取消转换；不负责 Runtime 重试、Tool 执行、权限、状态推进或自动切换其他 Provider。

## 当前状态

已实现官方 endpoint 的 Chat Completions/SSE
Adapter、ToolCall 聚合、usage、错误和取消映射。已有真实纯文本 smoke；无副作用 function ToolCall
acceptance 工具已就绪，但真实 ToolCall 仍待凭据运行和记录。

## 已实现

- 使用稳定 provider ID `deepseek` 和 `DEEPSEEK_API_KEY`，只连接官方 endpoint。
- 把 ModelRequest 与 `read`、`edit`、`shell` schema 映射为 Chat Completions messages/function
  tools。
- 把文本、ToolCall 参数、usage、finish reason、错误和取消映射为 ModelEvent。
- 通过共享 ModelClientPort contract、DeepSeek 专属 fixture 和受控人工 smoke。

## 前置条件

- Provider Registry、strict 配置 schema 和秘密注入可用。
- 模型 ID 和 thinking 参数由配置选择，不硬编码进 Core。

## 验收条件

- 新增 DeepSeek 不修改 RuntimeRunner 或 Core public types。
- ToolCall 流、usage、截断、错误、取消和未知协议事件均有确定性测试。
- 凭据、完整正文、reasoning content 和 Tool 参数不泄漏到日志或 Session。
