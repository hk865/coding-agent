# Project Memory Provider

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留未来项目级长期记忆的实现位置。

本 MVP 不实现跨会话知识抽取、语义检索、向量数据库或跨项目共享。

## 当前状态

截至 M4，本目录只有本 README；M5 只实现 Empty Provider，本目录继续延期。

## 启用前置条件

- 完成隐私、数据所有权、删除、版本、迁移和注入攻击威胁模型。
- 明确 write 的授权来源与 recall 的 workspace 隔离。
- 先有稳定 MemoryProviderPort 和可替换 Empty Provider 基线。

## 未来验收条件

- 不同 workspace 的记忆严格隔离。
- 写入、更新、删除和来源追踪可审计。
- 恶意 Memory 不能获得系统权限或绕过 PermissionPolicy。
- 关闭该实现不会影响 Session 恢复正确性。
