# Benchmarks

M6 可重复评测入口，分离任务、执行器、schema 与单次结果：

- `tasks/`：4 个版本化 MVP canary；
- `harness/`：Provider smoke、base/oracle/near-miss 预检与真实/replay baseline；
- `schemas/`：Provider smoke、任务、trial 和 run summary 的 strict schema；
- `results/`：运行产物，默认不提交，只保留格式说明。

运行任务预检：

```bash
npm run benchmark:validate
```

运行一次确定性 replay baseline：

```bash
npm run benchmark:baseline:replay
```

运行一次低预算真实 Provider smoke（同时验证文本和不执行的 ToolCall）：

```bash
npm run smoke:providers -- --provider <openai|deepseek> --model <model-id>
```

Replay 只验证 harness 和 evaluator，不计为真实模型能力基线。真实模型运行必须使用可追溯 commit、支持 bubblewrap 的 runner、固定 Provider/model/预算，并由
`agent-runner.mjs` 通过产品 Composition 执行。
