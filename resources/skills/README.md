# Skill Resources

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

保存 M5 最小 SkillProvider 使用的固定、只读 Skill fixture。

Skill 内容只是待选择的 instruction 或 reference data，不能直接执行工具、修改权限或访问任意文件。

## 当前状态

截至 M4，本目录只有本 README，尚无 Skill fixture、manifest 或版本 schema。

## M5 计划

- 提供少量固定 Skill fixture，覆盖 instruction 与 reference 两种 Context 类型。
- 为资源定义稳定标识、来源、优先级和版本。
- 只允许 Skill Loader 从明确配置的资源根读取。

## 前置条件

- SkillProviderPort、Skill Loader 和 Skill Registry 的窄接口在 M5 一起冻结。
- ContextBuilder 继续只接收已选择的 SkillContext 值。

## 验收条件

- fixture 可被确定性发现、解析和排序。
- 非法、重复或越界资源会被拒绝。
- Skill 接入不需要修改 RuntimeRunner。
