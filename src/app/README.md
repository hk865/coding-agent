# App

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

组合 CLI、Core 与所有外层 Adapter，形成用户可启动的应用边界。

App 可以依赖 Core 和 Adapter，但 Core 禁止反向依赖 App；业务状态转换仍由 Core
Runtime 和 Reducer 决定。

## 当前状态

已实现 CLI、strict 配置、Composition Root、新会话与恢复会话装配，以及确定性 child-process/PTY
smoke。

## 已实现

- 实现最小 CLI 输入、流式输出、审批、取消与退出码。
- 实现 Composition
  Root，通过 Registry 选择 OpenAI/DeepSeek，并装配 Tools、Storage、Policy、Sandbox 与 Observability。
- 建立应用生命周期和资源清理顺序。

## 前置条件

- M3 工具安全链和 M4 Session/恢复契约保持稳定。
- OpenAI/DeepSeek ModelClientPort Adapter、Provider Registry 和 M5 配置加载可用。

## 验收条件

- 可从命令行启动、完成一次流式 ToolCall 闭环并退出。
- Ctrl+C 能协作式取消且不遗留子进程。
- App 装配不要求修改 RuntimeRunner。
- Core 架构检查继续禁止反向依赖。
