# round-1 — 桌面端配置 SSE 中转地址

日期：2026-06-19

## 命令与结果

### typecheck（五包）
`npm run typecheck` → db / relay-client / console / worker / relay 全绿（无报错输出）。

### build（worker）
`npm -w @claude-center/worker run build` → prebuild 编译 db + relay-client，worker `tsc` 绿。

### 核心逻辑验证
`node docs/acceptance/relay-desktop-config/scripts/verify-relay-config.mjs`：

```
[1] 无 worker.json relay 字段时取 env
  PASS  relayUrl 来自 env
  PASS  relayPublishToken 来自 env
  PASS  relayWorkerToken 来自 env
[2] persistWorkerState 写入后覆盖 env
  PASS  worker.json 落盘含 relayUrl
  PASS  relayUrl 取持久化值
  PASS  relayPublishToken 取持久化值
  PASS  relayWorkerToken 取持久化值
[2b] 清空保存表示禁用（不回退 env）
  PASS  relayUrl 清空后为空（非回退 env）
[3] WorkerRelay.reconfigure() 随最新 config 变化
  PASS  有地址时 enabled=true
  PASS  未订阅前 state=disabled
  PASS  清空地址后 enabled=false
  PASS  清空地址后 state=disabled
  PASS  reconfigure 后频道数归零

ALL PASS
```

### HTML 产物完整性
`windowHtml()` 渲染含全部新元素：relayUrl / relayPublishToken / relayWorkerToken / saveRelay /
setRelayConfig / loadRelay / 「SSE 中转服务」；产物长度 94536。

## 结论
非 GUI 核心逻辑（config 持久化优先级 + 运行时 reconfigure 热生效）+ UI 产物均验证通过。
