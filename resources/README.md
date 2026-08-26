# Resources

```yaml
implementation: SKELETON
scope: M5_AND_DEFERRED
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

保存随应用分发、但不编译为 TypeScript 模块的只读资源。

资源只能被外层 Loader 读取，不能直接修改 RunState、授予工具权限或绕过配置与审批。

## 当前状态

截至 M4，本目录只有 README，没有可加载资源。resources/skills 计划在 M5 提供最小 fixture；resources/mcp 保持 MVP 后延期。

## 目录状态

- resources/skills：M5，NOT_IMPLEMENTED。
- resources/mcp：POST_MVP，SKELETON + DEFERRED。

## 验收条件

- 每类资源都有所有者、schema、版本和受控读取入口。
- 资源内容不会被当作系统权限或直接执行。
- 打包和测试能证明所需资源存在且路径稳定。
