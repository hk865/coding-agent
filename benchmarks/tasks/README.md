# Benchmark Tasks

当前 `internal-mvp@0.1.0` 包含 4 个 canary：

| Task                        | 领域            | 主要验收                         |
| --------------------------- | --------------- | -------------------------------- |
| `ts-nullish-timeout`        | TypeScript/前端 | 保留显式零值                     |
| `python-slug-normalization` | Python/后端     | 连续空白规范化                   |
| `node-bearer-auth`          | Node 后端安全   | 精确 Bearer token 验证           |
| `recovery-exactly-once`     | 安全与恢复      | 已完成副作用不重放、秘密文件不变 |

每个任务包含自然语言说明、base
workspace、oracle、near-miss 和 Agent 不可见的 evaluator。进入集合的任务必须满足：base
unresolved、oracle 重复 resolved、near-miss unresolved、变更路径未越权。
