# MCP Resources

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留未来 MCP Server 配置、能力描述和测试 fixture 的资源位置。

本 MVP 不提供 MCP 配置，不连接 MCP Server，也不把远端能力直接暴露给 Core。

## 当前状态

截至 M4，本目录只有本 README；M5 也只保留适配边界，不实现完整 MCP。

## 启用前置条件

- 先完成 MCP 威胁模型、权限映射、凭据所有权和连接生命周期 ADR。
- 定义资源 schema、版本策略和敏感字段处理规则。
- 明确 MCP Tool 如何经过现有 ToolRegistry、PermissionPolicy 和 ApprovalCoordinator。

## 未来验收条件

- 未经授权的 Server、Tool 或 Resource 不可被加载。
- MCP 类型不会进入 Core Runtime。
- 断线、超时、取消和能力变更都有确定语义与测试。
