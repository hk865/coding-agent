# Memory Providers

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

承载 MemoryProviderPort 的外层实现，为 Context 产生可选 MemoryItem。

Memory 与 Session/Checkpoint 分离，不是运行事实来源，也不能携带系统权限。

## 当前状态

截至 M4，src/memory 没有 TypeScript 实现；M4 恢复只重放 Session 事实，不恢复长期 Memory。

## M5 计划

- 冻结 MemoryProviderPort 的 recall/write 窄契约。
- 实现显式 Empty Provider 作为 MVP 默认值。
- 保留 project_memory 目录，但继续延期。

## 前置条件

- MemoryItem 与 ContextSelectionPolicy 的数据和裁剪语义保持稳定。
- 不把长期检索或向量数据库引入 MVP。

## 验收条件

- Empty Provider 通过共享 contract。
- Memory 接入不修改 RuntimeRunner。
- Memory 内容只作为 data 进入 ContextBuilder，并保留来源信息。
