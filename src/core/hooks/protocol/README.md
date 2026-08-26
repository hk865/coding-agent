# Hook Protocol

- **职责**：定义 before_model/before_tool/after_tool 输入和 Continue/Modify/Block/Pause/Fail 结果。
- **非职责**：不负责注册顺序、超时、异常归一化或强制安全策略。
- **允许依赖**：Core State、ModelRequest、ToolCall 与 ToolResult。
- **禁止依赖**：具体 Adapter、Policy 或 Sandbox 类型。
- **负责里程碑**：M1-05
- **当前状态**：CONTRACT + tested；after_tool 只能修改回填 output，身份和 effects 不可改写。
