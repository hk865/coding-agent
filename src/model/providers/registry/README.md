# Model Provider Registry

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

注册稳定 Provider ID、provider-specific 配置校验、能力描述和 ModelClientPort factory，供 App
Composition 显式选择模型服务商。

Registry 不定义第二套 ModelClient，不做自动路由、fallback、重试、模型评分或动态代码加载。

## 当前状态

已实现 `openai` / `deepseek` 静态注册、重复/未知 ID 拒绝、能力描述、秘密变量声明和显式 factory。

## 已实现

- 静态注册 `openai` 与 `deepseek`，拒绝重复或未知 Provider ID。
- 在启动期校验模型、ToolCall 能力、非敏感配置与所需秘密是否齐全。
- 只创建当前 Run 显式选择的一个 Provider，并生成稳定 `modelConfigId` 输入。
- 让新增 Provider 只需增加 Adapter、descriptor、fixture 和注册项，不修改 Runtime。

## 验收条件

- 配置选择、未知/重复 ID、能力不匹配和秘密缺失均 fail fast。
- Registry 与 Provider SDK 类型不进入 Core。
- Registry 不拥有模型重试、Tool list、安全策略或恢复决策。
