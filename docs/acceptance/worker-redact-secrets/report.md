# 报告 — 采集日志失败信息脱敏（全绿）

## 结论

Worker 采集套餐用量失败时不再外泄 oauth token。根因在 `apps/worker/src/shell.ts` 的
`runCommand` 把原始 argv（含 curl `Authorization: Bearer <token>`）拼进错误文案，
经 `fetchUsage` → `usage.error` 透到桌面日志面板（`this.log`）与 Console Worker 详情。
已在 `runCommand` 源头（失败 / 超时两处文案入口）统一调用 `redactSecrets` 脱敏，
一次性覆盖全部下游面与所有调用方。

## 验证

- e2e（真跑 curl 失败 + 真跑 node 超时）：7 用例 × round-1 全 PASS，见 `matrix.csv` / `round-1.md`。
- `npm run typecheck` 五包全绿；`npm -w @claude-center/worker run build` 通过。

## 影响面

- 行为变化仅限「失败 / 超时错误文案」：凭据被替换为 `Bearer ***` / `sk-ant-***`，其余命令上下文（命令名、exit code、stderr）保留，排查能力不降。
- 不带凭据 argv 的命令（git / gh / claude / where / node）文案不受影响（`redactSecrets` 只命中凭据模式）。
