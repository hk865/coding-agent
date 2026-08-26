# 开发指南

## 环境与安装

工程要求 Linux/WSL、Node.js 24 LTS 和 npm：

```bash
node --version
npm --version
npm ci
```

只有明确升级依赖时才使用 `npm install` 并更新 lockfile。

## 工程命令

| 命令                                | 作用                                     |
| ----------------------------------- | ---------------------------------------- |
| `npm run format:check`              | 检查格式                                 |
| `npm run lint`                      | 静态缺陷检查                             |
| `npm run typecheck`                 | TypeScript strict 检查                   |
| `npm run test`                      | build 后运行全部确定性测试与本机可用 E2E |
| `npm run test:e2e:bwrap`            | 强制真实 bubblewrap E2E                  |
| `npm run build`                     | 编译 `src` 到 `dist`                     |
| `npm run check:architecture`        | 依赖方向与循环检查                       |
| `npm run benchmark:validate`        | 4 个 canary 预检                         |
| `npm run benchmark:baseline:replay` | 生成固定 replay 结果                     |
| `npm run check`                     | 完整本地确定性门禁                       |

## 当前能力

M0–M5 主体实现已完成：Agent
Loop、read/edit/shell 安全链、Session/Checkpoint/SQLite 恢复、OpenAI/DeepSeek、CLI
run/resume、Skill/Empty
Memory 和外部 Tool 边界均已装配。M3 真实隔离门禁已通过；M6 正在收口真实 Provider、模型 baseline 和可追溯候选版本。

系统没有 `/usr/bin/bwrap` 时，shell 必须 fail closed；这不是安全降级。测试或显式部署可设置绝对路径
`CODING_AGENT_BWRAP_PATH`，再运行 `npm run test:e2e:bwrap`。当前 WSL 已用项目本地 bubblewrap
0.9 完成 6/6 强制 E2E；该本地 binary 位于被忽略的 tooling，不作为源码分发。
