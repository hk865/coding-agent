# Benchmark Schemas

`benchmark-schema.mjs` 定义并运行时校验：

- `benchmarkTaskSchema`：任务版本、语言、领域、base revision、环境、预算、网络和 evaluator；
- `benchmarkTrialResultSchema`：结果类别、Agent/model 元数据、资源用量和产物引用；
- `benchmarkRunSummarySchema`：各结果类别计数与 `resolved@1`。

任务的 `task.yaml` 使用 JSON-compatible YAML 编码，避免引入第二套配置 parser；schema 拒绝绝对路径和
`..` 逃逸。
