# Benchmark Harness

`cli.mjs` 提供两个稳定入口：

- `preflight`：对每个任务执行 base、oracle、near-miss 和第二次 oracle；
- `baseline --mode base|oracle|near-miss`：保存逐 trial 结果和汇总。

Harness 固定输出以下失败类别：

`resolved`、`unresolved`、`agent_error`、`timeout`、`environment_error`、`evaluator_error`、`policy_violation`。

每个 trial 保存 `result.json`、`trace.jsonl`、`diff.json` 和 `evaluator.log`。`agent-runner.mjs`
是真实模型 baseline 的受控入口：从环境读取所选 Provider 的密钥，使用 M5
Composition、静态单次审批和真实 sandbox；调用前仍必须满足可追溯 commit 与 bubblewrap 环境门禁。
