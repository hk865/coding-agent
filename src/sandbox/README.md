# Sandbox

- **职责**：强制 workspace 和 process 的执行边界。
- **非职责**：不做业务授权，也不能只靠字符串路径检查冒充 OS sandbox。
- **允许依赖**：平台隔离能力和 Policy 决策结果。
- **禁止依赖**：Core Runtime。
- **负责里程碑**：M3
- **当前状态**：M3 已实现 WorkspaceSandbox 与 ProcessSandbox；当前环境缺少 bubblewrap，因此真实进程隔离 E2E 仍受环境限制并保持 fail-closed。
