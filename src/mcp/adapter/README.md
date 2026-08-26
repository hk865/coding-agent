# MCP Adapter

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留把 MCP 能力映射为内部 Tool、Context 或未来明确 Port 的位置。

Adapter 必须隔离 MCP 类型，不能绕过 ToolRegistry、PermissionPolicy、ApprovalCoordinator 或 Runtime 事件协议。

## 当前状态

截至 M4，本目录只有本 README；M5 只用测试 Tool 验证扩展边界，不实现 MCP 映射。

## 启用前置条件

- 先定义每类 MCP 能力对应的内部所有者和安全分类。
- 为远端 Tool 建立稳定 schema、能力摘要和 sandbox/approval 规则。
- 为 Resource/Prompt 定义明确的 Context 数据边界。

## 未来验收条件

- 新 MCP Tool 能通过现有 ToolRegistry 接入而不修改 RuntimeRunner。
- 权限默认拒绝，远端元数据不能自授安全等级。
- MCP 故障映射为稳定内部错误，不泄漏 SDK 类型。
