# M2–M4 当前接口说明

```yaml
status: current
updated: 2026-08-24
scope: Runtime、工具安全链、Session/Checkpoint 与恢复的当前可执行接口
```

## M2 Runtime

`RuntimeRunner.run` 启动新 Run，`resume` 只接收 paused state，`continueRecovered` 只接收已经由
`RecoveryCoordinator` reconciliation 的稳定 state。恢复继续不会重复产生 `run.started`。

Runner 使用 strict `AgentEvent` +
Reducer 完成 model→tool→model 循环，支持请求重试、限制、取消、Hook、上下文裁剪、可信只读并行和 required/best-effort
EventSink。before_model Hook 修改后的 `ModelRequest`
会重新执行 token 硬预算；EventSink 有界超时，多个 required
sink 中单个失败不会让其余健康 sink 出现 sequence 缺口。

`SelectionPolicy` 先裁低优先级可选输入，再按“assistant
message + 对应的完整 ToolResult”删除最旧闭合 transcript 组。最新 user 和未闭合工具组受保护。模型流同时限制字符数和事件数。

## M3 Tools 与安全链

真实工具统一经 `ToolDispatcher`：通用 schema → frozen Registry → 具体 schema → Permission → Approval
→ workspace revision 复核 → capability → handler → ToolResult 协议校验。内置 `read`、`edit`、`shell`
分别提供有界 UTF-8 读取、带文件 revision 的原子单文件编辑，以及 bubblewrap 非交互命令。

Approval 是绑定 workspace identity/revision、policy 和 sandbox
profile 的一次性授权；审批期间 revision 变化会在 handler 前拒绝。`WorkspaceSandbox` 使用
`/proc/self/fd` 锚定的目录句柄逐段打开路径，避免 symlink TOCTOU。`ProcessSandbox`
不把宿主路径暴露给 bwrap 参数，敏感文件只读或隐藏；能力不可用时返回
`sandbox_unavailable`，不会退化为宿主执行。

`WorkspaceWriteResult.newRevision` 是目标文件内容 hash，供后续 `expectedRevision`
使用；`ToolEffects.workspaceRevision` 是全 workspace snapshot hash，供审批和恢复环境校验使用。

## M4 Session 与恢复

Session 保存 `session.created`、`turn.started` 和 `agent.event`
三类 append-only 事实；Checkpoint 是带事实游标、config、workspace、checksum 的派生快照。InMemory 与 SQLite 实现相同 Store
Port 语义，包括 revision conflict、幂等重试、批次原子性和最近 3 个 checkpoint。

`CheckpointStorePort.listCheckpointCandidates` 允许 Adapter 把单条损坏表示为
`{ checkpointId, checkpoint: null }`，恢复器据此删除坏记录并继续尝试更旧候选。`RecoveryCoordinator.recover`
对任何准备继续执行的状态要求当前 `RecoveryEnvironment`，并校验完整 config 与重放后最新 workspace
identity/reference/revision。

required `SessionEventSink` 保证 `tool.started`
持久化后才启动 handler。活动模型请求在恢复时只追加一次
`process_interrupted`；已开始但无结果的工具进入 `side_effect_result_unknown`
并终止原 Run，绝不自动重放副作用；稳定状态通过 `RuntimeRunner.continueRecovered` 回到正常闭环。
