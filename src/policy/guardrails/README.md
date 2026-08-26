# Guardrails

```yaml
implementation: SKELETON
scope: DEFERRED
target: POST_MVP
updated: 2026-08-26
```

## 职责与边界

预留未来内容级输入/输出防护和风险分类扩展。

Guardrail 不能替代 PermissionPolicy、ApprovalCoordinator 或 Sandbox；模型文本也不能授予工具权限。

## 当前状态

截至 M4，本目录只有本 README。当前安全边界由路径策略、审批、workspace/process
sandbox 和工具 schema 提供。

## 启用前置条件

- 明确 Guardrail 的威胁模型、执行点、失败模式和误报处理。
- 定义规则版本、审计记录和隐私边界。
- 决定阻断结果如何映射为现有 Hook 或 AgentEvent 协议。

## 未来验收条件

- Guardrail 不可扩大任何工具权限。
- 超时或故障采用明确的 fail-open/fail-closed 策略。
- 规则命中可审计，并有误报、漏报和注入攻击测试。
