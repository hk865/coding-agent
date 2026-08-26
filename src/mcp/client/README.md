# MCP Client

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留 MCP 协议消息、请求关联和客户端错误映射实现。

客户端不决定工具权限，不直接修改 Runtime，也不自行管理业务重试。

## 当前状态

截至 M4，本目录只有本 README；M5 不实现 MCP Client。

## 启用前置条件

- 选定协议版本与 SDK，并完成供应链和兼容性评估。
- 冻结超时、取消、错误分类和消息大小限制。
- 由 connection 层提供受控传输生命周期。

## 未来验收条件

- 请求与响应严格关联，未知或重复消息被拒绝。
- AbortSignal 能终止在途请求。
- 协议 fixture 覆盖成功、错误、超时和畸形消息。
