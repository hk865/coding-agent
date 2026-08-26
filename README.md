# Coding Agent

当前工程已完成 **M0–M5 主体实现**，正在执行 **M6：验收、Benchmark 与交付**。

工程具备可运行 Agent Loop、read/edit/shell 安全工具链、append-only
Session、Checkpoint、SQLite 持久化、OpenAI/DeepSeek 显式 Provider、Skill/Empty
Memory 边界、最小 CLI，以及可重复的 4-task canary
harness。Provider 不自动路由或 fallback；密钥只从所选 Provider 的秘密来源注入。

下一阶段为什么要增加 AgentDriver、Inbox、不可变 Profile 和多种状态投影，见
[`Agent Core 演进总览`](docs/architecture/evolution-overview.md)；与 DSH、Pi 的关系及本地 JSONL 证据见
[`Coding Agent、DSH 与 Pi 的关系`](docs/architecture/dsh-pi-relationship.md)。

## 环境

- Linux / WSL
- Node.js 24 LTS
- npm

首次安装和命令说明见 [`docs/development/getting-started.md`](docs/development/getting-started.md)。

## 工程门禁

```bash
npm run check
```

该命令执行格式、ESLint、TypeScript strict、build、全部测试、架构检查和 benchmark canary preflight。

额外环境门禁：

```bash
npm run test:e2e:bwrap
npm run benchmark:baseline:replay
```

## 当前已实现

- `core`：Run/Turn/State/Event、Model/Tool/Store/Skill/Memory
  Ports、Context、Hook、Limit、Cancellation；
- `core/runtime`：Reducer、Agent Loop、模型流协议、工具闭环、required sink、Checkpoint 和恢复协调；
- `tools`、`policy`、`sandbox`：Registry/Dispatcher、read/edit/shell、Permission/Approval、Workspace/Process
  Sandbox；
- `storage`：InMemory/SQLite Store、append-only Session、幂等/冲突控制、跨进程恢复；
- `model/providers`：OpenAI Responses 与 DeepSeek Chat Completions Adapter、静态 Registry；
- `app`：strict 配置、Composition Root、`coding-agent run/resume` CLI；
- `skills`、`memory`：固定资源 Loader/Registry 与无隐藏状态的 Empty Memory；
- `benchmarks`：strict
  schema、7 类结果、4 个 canary、base/oracle/near-miss 预检、trace/diff/evaluator artifact；
- CI：确定性门禁、真实 bubblewrap E2E 和固定 replay baseline artifact 分层。

M5 新增真实 CLI 子进程离线回放，覆盖
`read → final`、非交互审批拒绝、SIGINT 退出 130，并通过真实 PTY + bubblewrap 完成
`read → edit → shell → final` 和两次交互审批；SIGINT 场景还发现并修复了调用方取消被误记为 `failed`
的竞态。

## 当前验收状态

- M3-08 已在本地 WSL 和 GitHub Actions 的 Ubuntu 24.04 runner 通过 6/6 强制 bubblewrap
  E2E，覆盖 namespace/network、隐藏资源、timeout/cancel、孤儿进程、输出截断和完整 CLI；
- OpenAI 真实 smoke 未执行；DeepSeek 已完成纯文本 smoke，但两个 Provider 的真实 function ToolCall
  smoke 尚待记录；
- 固定 replay baseline 是 harness 自检，不是模型能力成绩；真实模型 canary baseline 尚待运行；
- 稳定基线已形成可追溯 Git commit 并推送；发布 tag 尚未创建；
- 长期 Memory、完整 MCP、自动 Provider 路由和约 40-task 扩容仍延期。

当前验证状态见 [`docs/testing/m6-verification.md`](docs/testing/m6-verification.md)，候选版本清单见
[`docs/development/release-checklist.md`](docs/development/release-checklist.md)。
