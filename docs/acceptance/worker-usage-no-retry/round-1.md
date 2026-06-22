# round-1 — 全绿

环境：Windows 11，本机已登录 Claude Code（`~/.claude/.credentials.json` 为 `max` 套餐，OAuth accessToken 存在）；
`CLAUDE_CENTER_USAGE_PROXY=http://127.0.0.1:10808`（本机代理）。e2e 跑 worker 的【已构建 dist】（随桌面端分发的同一份代码）。

## 编译

```
npm -w @claude-center/worker run typecheck   # tsc --noEmit，无报错 → PASS
npm -w @claude-center/worker run build        # db+relay-client prebuild + worker tsc，无报错 → PASS
```

## 真机 e2e

```
node docs/acceptance/worker-usage-no-retry/scripts/e2e-usage-no-retry.mjs
```

输出（token 已脱敏为 `Bearer ***`）：

```
[env] usageProxy=http://127.0.0.1:10808  usageIntervalMs=300000
[A] subscriptionType=max  usage={"fetched_at":"2026-06-22T12:58:56.830Z","five_hour":{"utilization":50,...},"seven_day":{"utilization":41,...}}
PASS — 本机凭据识别为套餐账号 max（实读 .credentials.json），当前=max
PASS — 真代理实采 oauth/usage 成功，拿到 5h/7d 窗口（5h=50% 7d=41%）
PASS — 采集失败被捕获为 error、未抛异常（error=...curl: (7) Failed to connect ... -x http://127.0.0.1:9 ...）
PASS — 失败但上轮有窗口 → 沿用上轮窗口 + 记录本轮 error（preserveUsageOnError）
PASS — refreshUsage:false 原样透传上轮 usage（同一引用）→ 未重新采集
PASS — 未发起网络调用（耗时 163ms，远小于一次 curl 超时）
PASS — 第 1 轮（到点采集）推进了采集时刻 lastUsageFetchAt=1782133140229
PASS — 第 1 轮采集失败，usage 仅含 error（请求失败：... -x http://127.0.0.1:9 ...）
# ↓ 真 runner this.log → console.error 透出的失败日志（含本次改动追加文案）：
Usage 采集失败（max 套餐）：请求失败：Command failed: curl.exe ... -H Authorization: Bearer *** ... -x http://127.0.0.1:9 ...
；本轮不重试，等下次采集触发再采
PASS — 第 2 轮未满 usageIntervalMs(300000ms) → 未重新采集、lastUsageFetchAt 不变（1782133140229）= 采集失败不重试
PASS — 第 2 轮原样沿用上轮 usage（透传 previousUsage），未发起新采集

ALL PASS — 采集失败不重试，等下一次采集触发
```

## 关键断言（ground-truth）

- **真采成功**：本机 `max` 账号经真代理实采 `oauth/usage`，拿到 5h=50% / 7d=41% 窗口（A）。
- **失败不抛**：坏代理（127.0.0.1:9，curl exit 7 连接被拒）→ `usage.error` 被捕获、不崩；上轮有窗口则保窗口+error（B）。
- **失败不重试（核心）**：真 `ClaudeCenterWorker.refreshInfo()` 第 1 轮失败把 `lastUsageFetchAt` 推进到
  `1782133140229`，紧接的第 2 轮因未满 `usageIntervalMs(300000ms)` **未重新采集**、`lastUsageFetchAt` 不变、
  `usage` 原样沿用 → 失败一轮即跳过、不自动重试（D）。
- **可观测**：真 runner 失败日志末尾出现本次新增的「`；本轮不重试，等下次采集触发再采`」。
