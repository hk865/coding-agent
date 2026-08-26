# M2–M4 验证记录

```yaml
status: current
updated: 2026-08-26
scope: 当前自动测试覆盖、跨进程证据和真实隔离门禁
```

## 自动覆盖

- M2：model→tool→model、请求重试与
  `retryOfRequestId`、usage、模型流乱序/事件上限、上下文闭合组裁剪、Hook 修改后二次预算、只读并行回填顺序、取消、模型/工具限制、Hook
  pause/resume；
- M2：required sink 多失败协调与超时、健康 required sink
  sequence 连续、best-effort 失败不改变业务终态；
- M3：路径穿越、最终文件和中间目录 symlink、fd 锚定访问、审批拒绝零副作用、审批等待期间 revision 变化、原子 edit、文件/workspace
  revision 区分、可信只读并行；
- M3：fake
  bwrap 验证 workspace 不暴露宿主路径，`.git`/`.env`/oracle 等路径被覆盖，以及 sandbox 缺失时 fail
  closed；
- M4：InMemory/SQLite 共享 create/append/read/conflict/idempotency/atomicity/checkpoint contract；
- M4：损坏最新 checkpoint 回退旧记录、当前 config/workspace 不兼容拒绝、active
  model 单次 interruption、pending tool 首次执行、running tool result_unknown；
- M4：稳定恢复状态接回 `RuntimeRunner` 到 final，且不重复 `run.started`；
- M4 跨进程：真实 edit 在 ToolResult 前崩溃时标记 result_unknown 且不重放；真实 edit 与 checkpoint 已提交后崩溃时，新进程按最新 workspace
  revision 恢复并继续到 final，副作用、ToolCompleted 和 terminal 均恰好一次。

完整门禁由 `npm run check` 执行 Prettier、ESLint、TypeScript、Vitest、构建和架构依赖检查。

## 环境说明

系统路径没有预装 bubblewrap；工程从 Ubuntu 包提取 bubblewrap
0.9 到被忽略的本地 tooling，并通过绝对路径显式启用。WSL 的 unprivileged
namespace 可用，`CODING_AGENT_REQUIRE_BWRAP=1` 强制门禁已通过：真实
`read → edit → shell → final`、network/隐藏资源隔离、timeout/cancel 进程树、孤儿进程和输出截断均有运行证据。缺少 capability 时仍 fail
closed，不会回退到普通子进程。

M4 的两条 SQLite + 真实 edit 跨进程恢复 E2E 也已通过。
