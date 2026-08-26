# MCP Connection

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留 MCP 传输建立、认证、健康状态、重连和关闭顺序的实现。

连接层不解释 Tool/Resource 业务语义，也不在断线后擅自重放有副作用操作。

## 当前状态

截至 M4，本目录只有本 README；没有 stdio、HTTP 或其他 MCP 传输实现。

## 启用前置条件

- 完成凭据来源、Server 身份、传输选择和重连 ADR。
- 明确进程退出、取消、超时和孤儿连接清理语义。

## 未来验收条件

- 连接资源在成功、失败和取消路径都能释放。
- 重连不会重复执行未知结果的副作用请求。
- 认证信息不进入普通日志或 Session 记录。
