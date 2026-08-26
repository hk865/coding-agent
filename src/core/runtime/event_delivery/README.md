# Event delivery

在状态提交前投递 required sink，失败时阻止原事件被接受；best-effort
sink 只产生诊断。协调器位于 Core，避免 Runtime 反向依赖 observability Adapter。
