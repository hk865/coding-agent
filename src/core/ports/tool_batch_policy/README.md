# ToolBatchPolicy Port

定义 Runtime 的工具批次调度边界。Core 默认串行；外层工具注册表只有在确认全部调用均为可信、独立、只读工具时，才能返回并行组。
