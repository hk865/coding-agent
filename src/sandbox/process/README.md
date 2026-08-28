# Process Sandbox

- **职责**：通过 Linux bubblewrap 隔离进程、挂载和网络；能力缺失时拒绝执行。
- **非职责**：不允许静默退化为普通子进程。
- **允许依赖**：bubblewrap 与显式 sandbox 配置。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3
  verified。ProcessSandbox 已实现超时、取消、输出限制、最小环境和进程树清理；默认探测
  `/usr/bin/bwrap`，测试或显式部署可通过绝对路径 `CODING_AGENT_BWRAP_PATH`
  指定兼容 binary。缺少 capability 时明确拒绝而不降级。真实 bubblewrap
  E2E 已覆盖完整工具链、网络隔离、隐藏资源、超时、取消、孤儿进程和输出截断。能力探针不再生成无意义的前后快照；业务命令返回 snapshot-before、execution、snapshot-after 三段耗时，并在命令后把确认的变更纳入 Agent 基线。
