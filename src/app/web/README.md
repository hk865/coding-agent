# 本机 Web UI

Web UI 是 CLI 之外的本机交互入口，复用相同的 App
Composition、Provider、SQLite、权限、审批和 sandbox。服务固定监听 `127.0.0.1`，不提供公网监听选项。

页面通过同源 HTTP 创建单个活动任务，通过 SSE 接收带 chunkIndex 的真实流式文本、DeepSeek
`reasoning_content`、已提交 AgentEvent 的运行轨迹和指标；edit/shell 审批使用独立 POST 返回。API
Key 只存在于浏览器输入框、单次 HTTPS/HTTP
loopback 请求和当前服务进程内，不写入 Session、日志或浏览器存储。

当前提供：新任务、异常恢复、流式回答、逐轮推理内容、允许一次/本任务允许同名工具/拒绝、取消、Provider/model/session/workspace选择、系统提示与启用 Tool/Skill 配置卡、模型与工具卡、可展开工具结果、Token/TPS、`使用量 / 上限`、耗时、1M 上下文占用和精确失败原因。任务级授权只复用人工审批，不绕过 Policy 硬拒绝、工作区 revision 或 Sandbox。Web
UI 还可选择 Session 路径、Git 工作区或严格对账模式，并展示 revision 策略与忽略目录。它仍是单任务控制器，不包含 durable
Inbox、多会话并发或长期 Memory。

指标来自 required
SessionSink 提交成功后的 best-effort 投影。当前事件协议没有首 token 时间，因此页面的 TPS 是 Provider 输出 token 除以整轮模型请求耗时，不冒充纯 decode
TPS。页面只展示 Provider 通过协议明确返回的推理字段；Provider 没有返回时不会伪造。
