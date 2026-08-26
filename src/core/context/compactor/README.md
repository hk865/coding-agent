# Context Compactor

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留未来上下文压缩和摘要契约的位置。

Compactor 不属于当前 MVP；现有 ContextSelectionPolicy 只做确定性裁剪，不生成摘要。

## 当前状态

截至 M4，本目录只有本 README。Runtime 已有 token 估算、选择和 transcript 成组裁剪，尚无压缩算法或摘要 Provider。

## 启用前置条件

- 冻结摘要的来源、版本、失效、可审计性和恢复语义。
- 明确压缩结果是缓存、派生数据还是 Session 事实。
- 建立 prompt injection、信息丢失和成本预算测试。

## 未来验收条件

- 压缩前后不可破坏未闭合 ToolCall 和当前用户消息。
- 恢复后能确定性重建或安全失效压缩结果。
- Compactor 失败可回退现有 SelectionPolicy，不影响事实状态。
