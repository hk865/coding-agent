# Skill Registry

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

索引 Loader 产出的 Skill，并按显式规则返回稳定选择结果。

Registry 不执行 Skill、不修改内容，也不根据模型自由文本动态授予能力。

## 当前状态

截至 M4，本目录只有本 README，没有注册、冻结或选择实现。

## M5 计划

- 按稳定 ID 注册并拒绝重复项。
- 在运行前冻结快照，避免请求处理中途变更。
- 支持配置或调用方明确指定的最小选择方式。

## 前置条件

- Skill Loader 输出格式和 SkillProviderPort 已确定。
- ContextSelectionPolicy 继续负责 token 预算裁剪。

## 验收条件

- 注册、重复检测、冻结和排序有单元测试。
- 选择结果包含可审计来源。
- Registry 接入不改变 ToolRegistry 或 PermissionPolicy。
