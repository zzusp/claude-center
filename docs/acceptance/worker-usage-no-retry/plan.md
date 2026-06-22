# 桌面端 Usage 采集失败不重试

## 需求

桌面端 Worker 采集套餐用量（远程 `oauth/usage`）失败时**不自动重试**，等下一次采集触发即可。

## 现状分析（先论后证）

**结论：该行为早已成立，但只是限流降频的隐式副作用，未被显式表达、也不可观测。**

- `runner.ts:refreshInfo` 把 `lastUsageFetchAt` 在「发起采集前」（`await inspectClaude` 之前）就推进：
  `const refreshUsage = now - lastUsageFetchAt >= usageIntervalMs; if (refreshUsage) lastUsageFetchAt = now;`
  → 成功/失败一致地占用本次采集时隙，**失败那轮不会在下一个 info tick（60s）提前重采**，必须等满
  `usageIntervalMs`（默认 5min）的下一次采集触发。
- `inspectClaude` 的 `refreshUsage` 形参是闸门：为 `false` 的轮次直接透传 `previousUsage`、不发起任何网络。
- `fetchUsage` 用单次 `curl --max-time 20`（无 `--retry`），`runCommand` 无重试循环 → 单轮采集内也无重试。
- 证据：模拟定时器（10×60s info tick、每轮失败）下重采只发生在 300s/600s（= `usageIntervalMs`），从不落在 60s tick。

源码注释只把它写成「避免 rate_limit_error」，日志里也看不出「本轮失败但不会重试、在等下一次触发」。

## 改动（最小、不动逻辑）

仅 `apps/worker/src/runner.ts`：把「采集失败不重试，等下一次采集触发」这条契约**显式化 + 可观测**，不改 timer 逻辑（已正确，改逻辑只会引回归）。

- `refreshInfo` 注释 + `lastUsageFetchAt = now` 处内联注释：点明发起前推进 = 失败一轮即跳过、不重试。
- `logUsage` 两条失败日志（沿用上轮的 info、无窗口的 error）追加「不重试，等下次采集触发」，让桌面日志面板可见。

## 验证

本地：`npm -w @claude-center/worker run typecheck` / `run build`。

真机 e2e（本机已登录 Claude Code 的 `max` 账号，跑已构建 dist）：
`node docs/acceptance/worker-usage-no-retry/scripts/e2e-usage-no-retry.mjs` — 覆盖真成功采集 / 失败捕获 /
不重试闸门 / 真 `runner.refreshInfo` 连跑两轮「失败一轮不重采」/ 失败日志含新文案。证据见 `round-1.md`、总表见 `matrix.csv`。

## 范围外发现（反馈不改）

采集失败的 `error` 文案里夹带 `runCommand` 抛出的 curl 全命令，含 `Authorization: Bearer <token>`，会随 `this.log`
透出到桌面日志面板——**既有行为**，属 token 泄漏隐患，但不在本任务（采集失败不重试）范围内，此处仅反馈、不顺手改。
e2e 脚本已对自身输出做脱敏（`Bearer ***` / `sk-ant-***`）以免留证泄漏。
