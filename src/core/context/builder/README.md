# Context Builder

- **职责**：从已取得的值按确定性层级组装 ModelRequest，验证 transcript 关联并稳定排序工具。
- **非职责**：不调用 Provider、Storage、Tool、文件系统或模型；M1 不做 token 裁剪。
- **允许依赖**：Context types、Runtime transcript 值和 ModelClientPort 类型。
- **禁止依赖**：外层 `tools`、`model`、`storage`、`skills`、`memory`。
- **负责里程碑**：M1-04 冻结组装边界；M2 增加 SelectionPolicy 与 Loop 集成。
- **当前状态**：`△ CONTRACT`，确定性、不可变性、排序和关联错误已通过 unit test。
