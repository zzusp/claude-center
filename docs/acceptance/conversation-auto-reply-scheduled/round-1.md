# Round 1 — 全绿

环境：worktree `worktree-11ccb8ea`，远程 dev PG `115.159.161.47:55432` 上的一次性干净库（零污染）。

## 1) typecheck（五包）
`npm run typecheck` → db / relay-client / console / worker / relay 全部通过，无报错。

## 2) 干净库全量迁移 + verify:console
`node scripts/ephemeral-db.mjs --verify`：
- 建临时库 → 顺序应用全部 **36** 个迁移（含 `036_conversation_auto_reply_scheduled.sql`）于单事务，`✓ migrations applied`（无报错 = 036 的 `ALTER seq DROP NOT NULL`、CHECK 重建、新列 + COMMENT + 部分索引均合法）。
- verify:console（next dev --turbopack）断言：`pageStatus: 200`，`health.db.ok: true`，`health.scheduler.ok: true`、`lastError: null`、`tickCount: 1` —— 证明调度器内新增的 `promoteDueScheduledConversationMessages` 调用未抛错。
- `✓ verify:console 通过` + `✓ dropped database`。

## 3) next build（五包，含 console webpack）
`npm run build` 全部成功；console 路由产物正常输出，无 webpack/edge 编译错误。

## 4) 查询层 e2e（真实驱动 @claude-center/db）
`node docs/acceptance/conversation-auto-reply-scheduled/scripts/e2e-queries.mjs`
（干净库 → 全量迁移 → 种子 project/worker/link → 驱动真实查询函数 → DROP）：

```
结果：PASS 22 / FAIL 0
```

覆盖：自动回复 create 持久化 + 设置部分更新（COALESCE）；即时消息认领；定时消息插入（seq=NULL/scheduled）→
未到点不进 prompt / 不被认领 → 调度器提升（赋 seq + done）→ 到点后进 prompt / 可被认领；同会话多条同时到点
seq 不冲突；取消未到点定时消息（仅 scheduled 可删）。

## 未覆盖（需真实 Worker + claude CLI，本环境不具备）
- Worker 端 `executeConversationTurn` 实际把 `conversationAutoReplyDirective` 注入 claude prompt 后的对话表现
  （已由 typecheck + 代码审阅保证拼接逻辑正确；运行需在线 worker + 已装 claude + 关联项目的真实检出）。
- 浏览器 UI 端到端点击流（新建对话面板/输入框定时控件/对话设置弹窗）；逻辑已由 typecheck + dev server 启动（verify:console）保证可编译可渲染。
