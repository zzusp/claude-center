# Round 1 — 采集日志失败信息脱敏

- 环境：Windows 11，worker dist 由 `npm -w @claude-center/worker run build` 构建。
- 命令：`node docs/acceptance/worker-redact-secrets/scripts/e2e-redact-secrets.mjs`
- C/D 用例为**真跑**：C 真起 `curl.exe` 对 discard 代理 `127.0.0.1:9`（连接被拒、必败），D 真起 `node` 挂住触发 `timeoutMs`。
- 凭据用假值（`FAKEoauth_DEADBEEF...` / `sk-ant-FAKEkey...`），断言「失败文案不含明文假值」。

## 输出（全绿）

```
PASS — A1 Bearer token → "Bearer ***"（-H Authorization: Bearer *** https://api.anthropic.com）
PASS — A2 sk-ant key → "sk-ant-***"（x-api-key: sk-ant-***）
PASS — A3 非凭据文本原样不动
PASS — B formatCommandFailure：不含明文 Bearer token
PASS — B formatCommandFailure：不含明文 sk-ant API key
PASS — B 仍保留脱敏占位与命令上下文（exitCode/stderr 可读）
PASS — C runCommand 非零退出（真 curl）：不含明文 Bearer token
PASS — C runCommand 非零退出（真 curl）：不含明文 sk-ant API key
PASS — C 失败文案仍含命令上下文且 token 已脱敏
PASS — D runCommand 超时：不含明文 Bearer token
PASS — D runCommand 超时：不含明文 sk-ant API key
PASS — D 超时文案脱敏后仍可读
PASS — E usage.error 回填：不含明文 Bearer token
PASS — E usage.error 回填：不含明文 sk-ant API key
PASS — E usage.error 仍带原因前缀（透到 this.log / Console 时已无 token）

ALL PASS — 采集失败文案已脱敏，token 不再透出
```

## 其它验证

- `npm run typecheck`：db / relay-client / console / worker / relay 五包全绿。
- `npm -w @claude-center/worker run build`：tsc 通过，`dist/shell.js` 含 `redactSecrets` 与两处调用点。
