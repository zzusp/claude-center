# 采集日志失败信息脱敏

## 症状

桌面 Worker 采集套餐用量（`oauth/usage`）失败时，失败原因里夹带了 curl 的**整条命令行**，
其中含 `-H Authorization: Bearer <token>`。该文案经两条链路外泄套餐 oauth token：

1. **桌面日志面板**：`runner.logUsage()` → `this.log("error", "Usage 采集失败：${usage.error}")` → `console.error`（worker stdout/桌面日志环）。
2. **Console Worker 详情**：`usage.error` 随 `reportInfo` 落库（`worker_info.usage`），`apps/console/app/ui/worker-detail.tsx:352` 直接展示。

> 旁证：既有 e2e `docs/acceptance/worker-usage-no-retry/scripts/e2e-usage-no-retry.mjs:17-23`
> 早已在测试脚本里防御性脱敏 console，注释明写「error 文案里夹带了 curl 全命令（含 Authorization: Bearer <token>）」——
> 说明泄漏点已知，但生产侧从未在源头修。

## 根因

`apps/worker/src/shell.ts` 的 `runCommand` 在命令失败 / 超时时，把**原始 argv** 拼进 `Error.message`：

- 非零退出：`formatCommandFailure()` → `Command failed: ${command} ${args.join(" ")}`（args 含 Authorization 头）。
- 超时：`Command timed out: ${command} ${args.join(" ")}`。

`inspect.ts` 的 `fetchUsage` 用坏代理 / 超时失败时（`inspect.ts:242`）把 `error.message` 原样包成
`请求失败：${error.message}` 写进 `usage.error` → token 顺着错误链外泄。

## 同根因排查

`runCommand` 是 worker 唯一拼 argv 进错误文案的入口，所有子命令（git / gh / claude / curl / where）共用。
当前仅 curl 的用量采集会把凭据放进 argv（`inspect.ts:fetchUsage`）；其余命令不带凭据 argv。
在 `runCommand` 源头脱敏可一次性覆盖**全部现有与未来调用方**，无需逐处补。

## 修复

`apps/worker/src/shell.ts`：新增 `redactSecrets(text)`，在两处错误文案拼装入口统一脱敏：

- `redactSecrets`：`Bearer\s+\S+` → `Bearer ***`、`sk-ant-\S+` → `sk-ant-***`（保留前缀便于排查、仅遮密文）。
- `formatCommandFailure`：返回前对整条文案（命令行 + stdout/stderr）脱敏（命令输出回显凭据也一并兜住）。
- 超时分支：`reject(new Error(redactSecrets(...)))`。

源头修复后，`usage.error` / `this.log` / Console 三个下游面均不再含 token，无需逐处改下游。

## 验证

真机 e2e（跑已构建 dist，假 token 实跑 curl / node，无需真实账号凭据）：
`docs/acceptance/worker-redact-secrets/scripts/e2e-redact-secrets.mjs`。覆盖矩阵见 `matrix.csv`，证据见 `round-1.md`。
