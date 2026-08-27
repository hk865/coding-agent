# A1 Session v2 契约

```yaml
status: implemented
stage: A1
updated: 2026-08-27
```

## 一分钟读懂

Session 是 Agent 的“不可擦账本”。A1 给新账本首页增加两枚印章：

- `lineage`：这本账从哪里来；
- `profile`：这次会话固定使用哪套 Agent 装配。

普通运行事实仍按 position 追加，旧账本不重写。扩展如果需要保存自己的事实，必须装进统一信封，不能向 Core 状态机无限增加事件种类。

## v1 与 v2 怎样共存

| 情况                     | 行为                                                      |
| ------------------------ | --------------------------------------------------------- |
| 旧调用不传创建版本       | 创建 v1，保持源兼容                                       |
| 新生产 Composition       | 显式创建 v2                                               |
| SQLite database schema 1 | 自动加两个 nullable JSON 列并把数据库元数据升级到 2       |
| 已有 v1 Session          | 行和记录 JSON 保持 v1，校验和不变，可继续读取、追加和恢复 |
| 新 v2 Session            | Header 与首条 `session.created` 都保存 lineage/profile    |
| v2 Profile 不匹配        | 新 Turn 或 resume 在模型/工具执行前以 `conflict` 明确失败 |

数据库版本和 Session 版本是两回事：数据库 v2 可以同时保存 Session v1 与 v2。

## Lineage

| kind        | 约束                                                         |
| ----------- | ------------------------------------------------------------ |
| `root`      | 没有父 Session、父位置或父校验和，`delegationDepth` 必须为 0 |
| `fork`      | 必须绑定父 Session、正数 position 和父记录 SHA-256 校验和    |
| `delegated` | 与 fork 一样绑定父边界，且 `delegationDepth` 必须为正数      |

这一步先把不可变谱系契约建好。真正执行 fork 与子 Agent 委派分别在 A4、A6 实现。

## Profile 身份

`AgentProfileIdentity` 只有三个字段：

```text
profileId       人类可识别的装配名称
profileVersion  计算摘要所用的规则版本
profileDigest   具体装配的 SHA-256 摘要
```

当前生产摘要覆盖基础配置、模型配置 ID、工具 schema 摘要、策略版本、沙箱版本、工具顺序、Skill
ID 和 Memory Provider。它不保存 API
Key。A5 会在这个稳定身份上增加完整的不可变 Profile 内容和 ExtensionHost 生命周期。

## 扩展事实信封

`extension.fact` 的 payload 固定为：

| 字段              | 含义                                     |
| ----------------- | ---------------------------------------- |
| `namespace`       | 扩展所有者，避免名称冲突                 |
| `factType`        | 该扩展内部的事实类型                     |
| `schemaVersion`   | 扩展自己的正整数版本                     |
| `ignorable`       | 没有 consumer 时是否允许安全跳过         |
| `modelVisibility` | 声明为 `hidden` 或未来可投影为 `context` |
| `data`            | 经过 JSON schema 约束的数据              |

当前 A1 Core 把所有扩展事实视为“未知”：

- `ignorable: true`：可靠写入日志，但 RunState 投影跳过；事实放在 Turn 前后都能恢复；
- `ignorable: false`：没有已安装 consumer 时拒绝追加或重放，不能假装理解；
- `modelVisibility: context`：只是一份声明，A3 Context Projection 落地前不会自动暴露给模型。

因此，灵活性不会扩大 `AgentEvent -> Reducer -> RunState` 这条严格状态通道。

## 已验证的不变量

- InMemory 与 SQLite 使用同一 v1/v2 contract；
- v2 Header 和 `session.created` 的 lineage/profile 一致；
- 未知可忽略事实不会改变 RunState，也不破坏 `RecoveryCoordinator`；
- 未知不可忽略事实失败时整个 append 批次不提交，revision 不前进；
- 真实旧结构 SQLite 文件原位迁移后，旧记录逐字保持并通过原校验和；
- SQLite Header 的 lineage/Profile 与首条创建事实交叉验证，合法格式的索引行漂移也会报损坏；
- 全仓门禁通过：30 个测试文件，97 passed、3 skipped；architecture check 与 benchmark
  preflight 同时通过。
