# MCP

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留未来 MCP 协议客户端、连接生命周期和内部能力适配边界。

本 MVP 不连接 MCP Server；Core Runtime 禁止直接依赖 MCP 类型。

## 当前状态

截至 M4，src/mcp 及其子目录只有 README。M5 仅验证外部 Tool 可通过现有 Registry 接入，完整 MCP 继续延期。

## 启用前置条件

- 完成 MCP 权限、信任、凭据、能力发现和断线恢复 ADR。
- 明确远端 Tool、Resource、Prompt 与现有 Tool/Context 边界的映射。
- 所有有副作用能力必须经过 PermissionPolicy、ApprovalCoordinator 和 Sandbox。

## 未来验收条件

- MCP SDK 类型不会进入 Core。
- Server 能力变化、超时、取消和断线有确定协议。
- 未授权能力默认拒绝，日志和 Session 不泄漏凭据。
