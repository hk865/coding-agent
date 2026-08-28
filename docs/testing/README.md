# Testing

与当前实现同步的验证记录：

- [M0 工程基线验证](m0-verification.md)
- [M1 Core 契约验证](m1-verification.md)
- [M2–M4 Runtime、工具、Storage 与恢复](m2-m4-verification.md)
- [M5 App、Provider、CLI 与扩展边界](m5-verification.md)
- [M6 验收、canary 与剩余门禁](m6-verification.md)
- [Web UI、长会话故障与真实业务测试说明](web-ui-business-verification.md)

常用命令：

```bash
npm run test
npm run test:e2e
npm run test:e2e:bwrap
npm run benchmark:validate
npm run benchmark:baseline:replay
npm run smoke:providers -- --provider <openai|deepseek> --model <model-id>
npm run benchmark:baseline:real -- --provider <openai|deepseek> --model <model-id>
npm run check
```

`test:e2e:bwrap` 要求真实 bubblewrap；缺少能力时普通测试明确 skipped，强制门禁会失败。Replay
baseline 只验证 harness，不替代真实 Provider benchmark。
