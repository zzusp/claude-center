# Round 3 — P2 API/SSE + P3 UI

## P2：对话 API + SSE 端到端（真 HTTP + 真 SSE 流）

跑法：`node docs/acceptance/worker-direct-chat/scripts/verify-api-sse.mjs`

boot console（next dev）对一次性干净库 → admin 登录拿 cookie → 走对话 REST → **模拟 worker 写分片 + `pg_notify`** → fetch SSE 流读取，断言收到流式 delta + done。验证 `LISTEN/NOTIFY → SSE → 客户端` 整条实时链路（无需真 worker/claude）。

### 结果：13/13 PASS

```
✓ ephemeral db migrated
✓ console ready on 61312
  PASS  admin 登录拿到 cc_session cookie
  PASS  POST /api/conversations → 201 建会话
  PASS  未关联项目的 worker 建对话 → 400
  PASS  GET /api/conversations 列表含新会话
  PASS  未登录 GET /api/conversations → 401
  PASS  POST .../messages → 201 发用户消息
  PASS  SSE 连接收到 open 事件
  PASS  worker 模拟：认领到 assistant streaming 轮
  PASS  SSE 收到 3 个 delta（流式 token 推达浏览器）
  PASS  SSE delta 拼接 = 最终文本
  PASS  SSE 收到 done 事件
  PASS  POST .../close → 结束对话
  PASS  GET 详情 → status=closed
✓ cleaned up

ALL PASS
```

→ matrix API-01 / API-02 / SSE-01 PASS。

## P3：console UI（chat 视图）

- `npm run typecheck`（三包）绿。
- `npm run build`（含 `next build`）绿——chat 视图 / 新建面板 / SSE EventSource 客户端编译通过。
- `node scripts/ephemeral-db.mjs --verify`：对全量迁移（含 017）干净库起 console，`401→登录→200`、health/scheduler 绿，临时库干净删除。

→ matrix UI-01 PASS。

## 未自动化（诚实标注）

- **UI-02（浏览器交互流式渲染 / 打字机）**：MANUAL。驱动 SSE 的 delta 推送已被 SSE-01 证实，组件已 typecheck+build；浏览器里逐字渲染的视觉效果待人工手测（背景会话无 GUI）。
- **SSE-02（跨实例 NOTIFY 广播 + Last-Event-ID 重连续传）**：PENDING。单实例 NOTIFY + 2s 慢轮询兜底已验；多 console 实例广播与断线续传未自动化（设计上靠每实例各自 LISTEN + chunks 表 seq 续传，见 spec §5.2）。
