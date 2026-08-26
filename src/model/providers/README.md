# Model Providers

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

作为具体模型厂商 Adapter 的容器，统一约束 Provider 的目录和测试边界。

每个 Provider 只能实现 ModelClientPort 与自身配置映射，不能拥有 Runtime 状态机或工具权限规则。

## 当前状态

截至 M4，本目录的 registry、openai、deepseek 子目录只有 README，没有 Provider 实现或厂商 SDK 依赖。

## M5 计划

- 静态注册并完成 OpenAI 与 DeepSeek 两个 MVP Provider。
- 为每个 Provider 建立专属协议 fixture、错误分类和取消 contract，并复用共享 ModelClientPort
  contract。
- 通过 Composition 显式选择一个 Provider，不在 Core 中建立路由。
- 固定生产 Tool list 为 read/edit/shell；Provider 不得注入厂商 hosted tools。

## 验收条件

- Provider 输出满足 ModelClientPort 事件序列规则。
- 凭据不会进入请求快照、日志或测试 fixture。
- 新增 Provider 不需要修改 RuntimeRunner。
