# Metrics

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留未来聚合运行指标和指标后端适配的位置。

Metrics 是 best-effort 可观测性能力，不能成为 RunState 事实来源，也不能阻断业务提交。

## 当前状态

截至 M4，本目录只有本 README。当前仅实现结构化日志和内存 trace sink。

## 启用前置条件

- 定义低基数指标名称、标签预算、采样和保留策略。
- 完成敏感数据、workspace 标识和模型成本字段的隐私评审。
- 选择后端前先冻结内部指标事件边界。

## 未来验收条件

- 指标失败不会改变 Agent 终态。
- 标签基数、内存和导出延迟有上限。
- 指标不包含提示词、工具输出、密钥或用户文件内容。
