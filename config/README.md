# Configuration

```yaml
implementation: NOT_IMPLEMENTED
scope: M5
current_stage: M4_COMPLETE
updated: 2026-08-26
```

## 职责与边界

保存可版本化、非敏感的应用配置模板，并为 App Composition 提供确定的配置输入。

本目录不得保存 API 密钥、用户私有配置或运行时生成的状态；Core
Runtime 也不得直接读取环境变量或配置文件。

## 当前状态

截至 M4，本目录只有本 README，尚无配置 schema、默认配置或加载实现。

## M5 计划

- 定义最小 CLI、provider/model、工具、存储、策略与可观测性配置。
- 以 strict 判别 schema 支持 `provider=openai|deepseek`，拒绝未知 provider/options。
- 明确默认值、配置文件、环境变量和命令行参数的优先级。
- 把 `OPENAI_API_KEY`、`DEEPSEEK_API_KEY` 作为外部注入值处理，不写入可版本化模板。
- 由 App Composition 完成解析，再把稳定值传给 Core 与 Adapter。

## 前置条件

- M3 的权限、审批和 sandbox 配置边界保持稳定。
- M4 的 RunConfigSnapshot 与恢复兼容性字段保持稳定。

## 验收条件

- 同一输入产生确定配置，优先级有自动化测试。
- 非法值在应用启动阶段失败，不进入 Runtime。
- 日志和错误信息不会泄漏密钥。
- 配置变化能正确反映到 Session 恢复兼容性校验。
