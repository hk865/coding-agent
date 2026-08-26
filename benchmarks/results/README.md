# Benchmark Results

单次结果默认不提交。目录格式：

```text
<run-id>/
├── summary.json
└── <task-id>-trial-1/
    ├── result.json
    ├── trace.jsonl
    ├── diff.json
    └── evaluator.log
```

`result.json` 保存任务 digest、Agent commit、Provider/model、预算、环境、结果类别和效率指标；`summary.json` 保存所有结果类别计数及 `resolvedAt1`。CI replay 结果作为短期 artifact 保留，不当作真实模型成绩。
