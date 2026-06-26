# Round 1 — Claude Code 消息解析优化

时间：2026-06-26（worktree `worktree-25b7ec7d-...`）

## 结果

13/13 PASS。`scripts/e2e-message-parsing.mts` 单脚本端到端跑通，含解析层 + DB 调度 / 领取层 + Console UI 实地观察。

## 工作流

```powershell
node --import tsx docs/acceptance/claude-message-parsing/scripts/e2e-message-parsing.mts --check  # 零副作用自检
node --import tsx docs/acceptance/claude-message-parsing/scripts/e2e-message-parsing.mts          # 全套（建库→种数据→起 Console→playwright→DROP）
```

输出 `round-1/results.json`（每个 case 状态 + 备注）与 `round-1/screenshots/`（playwright 截图）。

## 解析层断言（P1–P5）

| case | 证据 |
| --- | --- |
| P1 | 合成 jsonl 含 4 条 user，2 条 isMeta:true（local-command-caveat / skill 文档）；`parseTranscript` 输出无 skill 文本气泡 |
| P2 | 合成 jsonl 含 1 条不带 isMeta 但内容以 `<command-name>/run<…>` 起首的 user；过滤后仍不进入 user 气泡 |
| P3 | 合成 jsonl 派发 bgA + bgB，仅 bgA 收到 `<task-notification status=completed>`；`extractBackgroundJobs` 返回 2 条 / `pendingBackgroundJobs` 返回 1 条（bgB，description="长跑日志同步"） |
| P4 | `scripts/verify-session-targeting.mjs` 临时 `CLAUDE_CONFIG_DIR` 下伪造 A 旧 B 新两个 .jsonl，5 case 全过：legacy newest=B / sinceMs filter A=B / preferSessionId hit A=A / preferSessionId miss + sinceMs=B / future sinceMs=null |
| P5 | 同上 case 3：preferSessionId="A" 即使 B 更新仍命中 A |

## DB 调度 / 领取层断言（S1–S3）

| case | 证据 |
| --- | --- |
| S1 | `addConversationMessage(scheduledAt=now-60s)` 后 `status='scheduled'`、`seq=NULL` |
| S2 | `promoteDueScheduledConversationMessages` 返回 1；该消息翻 `status='done'`、`seq=2`（连续编号） |
| S3 | `claimNextConversationTurn(workerId)` 立刻拿到一条 streaming assistant 轮，conversation_id 一致 |

## Console UI 实地观察（U1–U3）

dev server（Next.js Turbopack）起在空闲端口，admin/admin123 登入 `/chat?c=<convId>`：

| case | 证据 | 截图 |
| --- | --- | --- |
| U1 | 共 2 条 `.tx-msg.asst`，末条内容包含 "A 已完成；B 仍在跑（长跑），完成时会再唤醒本对话。" | `screenshots/chat-msgs.png` |
| U2 | 共 1 条 `.tx-msg.user`，文本是用户原话；不含 "run skill" / "skill 的完整文档" / `<local-command-caveat` / `<command-name` | `screenshots/chat-msgs.png` |
| U3 | `.sm-chip:has-text("后台")` 文本 = "后台 1"（橙色 pending tone） | `screenshots/session-meta-bar.png` |

`screenshots/chat-thread.png` 是整页 1440×900 截图，可一眼看到全部三处效果。

## B1 / B2

| case | 证据 |
| --- | --- |
| B1 | 本会话此前 `npm run typecheck` + `npm run build` 五包绿；本轮 transcript-parse.ts 抽出后再跑一次仍绿 |
| B2 | e2e 本身建 ephemeral DB 跑全量迁移 + Console dev 启动 + login + dashboard 全通 |
