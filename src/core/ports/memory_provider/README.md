# Memory Provider Port

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

定义外层 Memory 系统 recall/write MemoryItem 的窄端口。

MemoryItem 值由 core/context/types 拥有；Port 不规定数据库、向量检索、自动摘要或跨项目共享。

## 当前状态

已实现受 AbortSignal 控制的 `recall` / `write` 契约、严格输入 schema、稳定错误分类和 Empty Provider
contract。

## 已实现

- 定义受 AbortSignal 控制的 recall/write 输入、返回值和最小错误分类。
- 实现 Empty Provider，作为显式无长期记忆的默认边界。
- 保证 Memory 与 Session/Checkpoint 的事实存储严格分离。

## 前置条件

- 与 Empty Memory Provider 和 Context SelectionPolicy 的消费方式一起验证。
- 不提前引入 project memory 或向量数据库需求。

## 验收条件

- Fake 与 Empty Provider 通过同一 contract。
- 空实现行为确定、可取消且不会隐式持久化。
- Memory 接入不修改 RuntimeRunner，且内容始终作为 data 处理。
