# Memory Providers

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

承载 MemoryProviderPort 的外层实现，为 Context 产生可选 MemoryItem。

Memory 与 Session/Checkpoint 分离，不是运行事实来源，也不能携带系统权限。

## 当前状态

MemoryProviderPort 与显式 Empty Provider 已实现；长期 project
memory 继续延期，且不参与 Session 事实恢复。

## 已实现

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
