# CLI

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

解析命令行和用户输入，展示流式文本、工具状态与审批请求，并映射稳定退出码。

CLI 不直接构造 Core 内部状态，不决定权限，也不绕过 Composition 获取具体 Adapter。

## 当前状态

已实现 `run` / `resume`、流式输出、交互/非交互审批、SIGINT 协作取消和稳定退出码。

## 已实现

- 支持 cwd、模型与配置选择、单轮输入和流式文本展示。
- 展示工具开始、完成、失败和审批信息。
- 实现 ApprovalRequester 的真实终端交互 Adapter。
- 把 Ctrl+C 传递给 CancellationController，并根据终态映射退出码。

## 前置条件

- App Composition 能提供完整运行依赖。
- 配置优先级、敏感信息规则和终态到退出码映射已冻结。

## 验收条件

- 固定回放 smoke 能完成 read → edit → shell → final。
- 取消、拒绝、超限、模型失败和存储失败都有稳定展示与退出码。
- 非交互环境不会无限等待审批或输入。
