# Benchmark Harness

`cli.mjs` 提供两个稳定入口：

- `preflight`：对每个任务执行 base、oracle、near-miss 和第二次 oracle；
- `baseline --mode base|oracle|near-miss|agent`：保存逐 trial 结果和汇总。

`provider-smoke.mjs` 通过正式 Provider Registry 分别验证短文本和固定 `record_smoke_result`
ToolCall。ToolCall 不执行；summary 不保存正文、reasoning 或原始参数，只保存哈希和结构化事件证据。

Harness 固定输出以下失败类别：

`resolved`、`unresolved`、`agent_error`、`timeout`、`environment_error`、`evaluator_error`、`policy_violation`。

每个 trial 保存 `result.json`、`trace.jsonl`、`diff.json` 和 `evaluator.log`。`agent-runner.mjs`
是真实模型 baseline 的受控入口：从环境读取所选 Provider 的密钥，使用 M5
Composition、静态单次审批和真实 sandbox；调用前仍必须满足可追溯 commit 与 bubblewrap 环境门禁。结果同时保存有效的 Provider/model/options；DeepSeek
baseline 固定并记录 `thinking=disabled`，避免厂商默认值变化破坏可重复性。

真实 baseline 会检查 Git tracked/untracked 状态；工作区不干净时拒绝运行。bubblewrap 优先读取绝对路径
`CODING_AGENT_BWRAP_PATH`，否则使用 `/usr/bin/bwrap`，不存在或不可执行时记录 `environment_error`。
