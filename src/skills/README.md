# Skills

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

加载、索引并选择可提供给 ContextBuilder 的 SkillContext。

Skill 不直接执行其中描述的行为，不修改 RunState，也不能授予工具权限。

## 当前状态

截至 M4，src/skills 只有 README，没有 Loader、Registry 或 Provider 实现。

## M5 计划

- 从固定 resources/skills 根加载最小 Skill fixture。
- 通过 Registry 建立稳定索引和明确选择规则。
- 经 SkillProviderPort 输出已校验的 SkillContext。

## 前置条件

- SkillProviderPort 和资源 schema 在 M5 冻结。
- 路径读取必须服从资源根边界，不能扫描任意 workspace。

## 验收条件

- 加载和选择结果稳定、可追踪来源且有重复项检测。
- instruction 与 reference 在 ContextSelectionPolicy 中保持既有优先级语义。
- 新增 Skill 不需要修改 RuntimeRunner。
