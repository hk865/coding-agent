# Skill Loader

```yaml
implementation: IMPLEMENTED
scope: M5
current_stage: M6_ACCEPTANCE
updated: 2026-08-27
```

## 职责与边界

从明确配置的只读资源根解析 Skill 文档和元数据。

Loader 不选择 Skill、不执行内容，也不访问任意 workspace 或网络位置。

## 当前状态

已实现固定根目录加载、大小/路径/schema/重复 ID 校验、内容摘要来源和确定性排序。

## 已实现

- 定义最小 Skill 资源格式和版本。
- 对路径、文件大小、编码、schema 和重复标识进行校验。
- 产出 Registry 可索引的不可变 Skill 描述。

## 前置条件

- resources/skills 提供固定 fixture。
- SkillProviderPort 与 SkillContext 字段保持一致。

## 验收条件

- 相同资源产生相同排序和内容。
- 非法、重复、越界和符号链接逃逸资源被拒绝。
- 错误信息可诊断但不泄漏不相关文件内容。
