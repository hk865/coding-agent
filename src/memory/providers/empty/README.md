# Empty Memory Provider

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

实现显式无长期记忆的 MemoryProviderPort 默认适配器。

它不伪造 recall 结果，不保存 write 输入，也不把空实现伪装成持久化成功。

## 当前状态

已实现确定性的无状态 Provider：recall 返回空集合，write 返回
`provider_disabled`，两者都校验输入并响应取消。

## 已实现

- recall 始终返回空的 MemoryItem 集合。
- write 执行确定性 no-op，并遵守取消和输入校验。
- 不创建文件、数据库、网络连接或隐藏进程状态。

## 前置条件

- MemoryProviderPort 的 recall/write 语义已冻结。

## 验收条件

- 通过 MemoryProviderPort 共享 contract。
- 多次调用无副作用、无状态泄漏且结果稳定。
- 作为 Composition 默认值时，Agent 仍能完成无 Memory 的闭环。
