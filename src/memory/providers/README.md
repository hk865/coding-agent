# Memory Provider Implementations

```yaml
implementation: PARTIAL_PLAN
scope: M5_AND_DEFERRED
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

作为 MemoryProviderPort 具体实现的容器。

各实现只能产出和接收 MemoryItem，不得替代 Session/Checkpoint，也不得直接控制 Runtime。

## 当前状态

截至 M4，子目录均只有 README。empty 计划在 M5 实现；project_memory 保持 MVP 后延期。

## 目录状态

- providers/empty：M5，NOT_IMPLEMENTED。
- providers/project_memory：POST_MVP，SKELETON + DEFERRED。

## 验收条件

- 所有实现复用同一 MemoryProviderPort contract。
- 实现差异不会改变 ContextBuilder 或 RuntimeRunner。
- 持久化、隐私和跨项目边界必须由各实现单独记录。
