# Skill Provider Port

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

定义外层 Skill 系统向 Core 提供 SkillContext 的窄端口。

SkillContext 值仍由 core/context/types 拥有；Port 不定义文件格式、目录扫描、工具执行或权限提升。

## 当前状态

截至 M4，本目录只有本 README，尚无 SkillProviderPort TypeScript 契约。

## M5 计划

- 定义受 AbortSignal 控制的查询/选择输入与返回值。
- 返回已校验、带来源和稳定标识的 SkillContext。
- 定义最小错误分类，避免 Loader 错误泄漏到 Runtime。

## 前置条件

- 与 Skill Loader、Registry 和固定 resources/skills fixture 一起设计。
- 保持 ContextBuilder 只接收值，不主动调用 Provider。

## 验收条件

- Fake 与固定资源实现通过同一 contract。
- Skill 接入不修改 RuntimeRunner 或 ContextBuilder 协议。
- Skill 不能授予 Permission 或绕过 ToolDispatcher。
