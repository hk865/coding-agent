# Session Store Port

- **职责**：定义 Session 元数据和消息历史的持久化边界。
- **非职责**：不选择数据库或序列化格式。
- **允许依赖**：Core 自有 Session 值类型。
- **禁止依赖**：storage 实现细节。
- **负责里程碑**：M4
- **当前状态**：M4 已实现 append-only
  Session、分页读取、revision 乐观并发和 SessionStorePort，并由内存/SQLite 适配器共享验证。
