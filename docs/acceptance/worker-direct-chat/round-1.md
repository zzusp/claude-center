# Round 1 — P0 数据层

跑法：`npx tsx docs/acceptance/worker-direct-chat/scripts/verify-data-layer.mts`

对一次性干净库（`cc_dchat_verify_<ts>`）跑全量迁移链（16 个迁移，含 `017_conversations.sql`）+ 全套 conversation 查询函数往返断言，用完 `DROP DATABASE WITH (FORCE)`，零污染共享 dev 库。

## 结果：22/22 PASS（DL-01 ~ DL-16 全绿）

```
✓ applied 16 migrations (incl. 017_conversations)
✓ seeded project/worker/link/user

  PASS  createConversation → active 会话指向该 worker
  PASS  addConversationMessage(user) seq=0 done
  PASS  getConversationPrompt → '你好'
  PASS  claimNextConversationTurn(别的 worker) → null
  PASS  claimNextConversationTurn → assistant streaming seq=1
  PASS  claim 时已有 streaming → 再领 null
  PASS  getConversationChunks 拼回 '你好呀'
  PASS  getConversationChunks(afterSeq=0) → 续传 1 片
  PASS  finalize → 会话写回 claude_session_id
  PASS  listConversationMessages → assistant done body='你好呀'
  PASS  已答完 → 领取 null
  PASS  第二轮 getConversationPrompt 只含新问题
  PASS  第二轮 claim → assistant seq=3
  PASS  failConversationTurn → failed + error_message
  PASS  失败轮终态 → 直接再领 null（不自动重试）
  PASS  用户再发消息后 → 可领取新轮 seq=5
  PASS  listConversations(有权项目) → 1 条
  PASS  listConversations(空白名单) → 0 条
  PASS  listConversations(admin/null) → 1 条
  PASS  getConversationLocalPath → 'D:/repos/p'
  PASS  closeConversation → status closed
  PASS  closed 会话 → 不再领取

ALL PASS
```

## 过程中修正

1. **脚本漏 COMMIT**：迁移块缺 `COMMIT`，client 断开回滚 → 首跑 `relation "projects" does not exist`。补 COMMIT 后通过。
2. **失败语义对齐**：初版断言"失败轮可再领重答"与查询逻辑冲突；确认设计为"失败轮终态、用户再发消息才重答"，改断言匹配（DL-13）。

## typecheck

`npm -w @claude-center/db run typecheck` 绿。
