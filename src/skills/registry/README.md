# Skill Registry

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

索引 Loader 产出的 Skill，并按显式规则返回稳定选择结果。

Registry 不执行 Skill、不修改内容，也不根据模型自由文本动态授予能力。

## 当前状态

已实现注册、重复检测、冻结、显式 ID 选择和稳定结果排序。

## 已实现

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
