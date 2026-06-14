# Round 2 — P1 worker 流式（真 claude 端到端）

跑法：`npx tsx docs/acceptance/worker-direct-chat/scripts/verify-stream-e2e.mts`（需代理 `HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:10808`，脚本自带）

对一次性干净库 + **本地 bare origin/clone**（免网络做 git）seed 一条会话，驱动真实的 `executeConversationTurn` 跑 **真 claude `--output-format stream-json`**，断言流式分片落库、最终 body、session 回写、只读保证。用完 DROP 库 + 删临时 git 目录。

## 结果：8/8 PASS

```
✓ local git origin + clone ready
✓ ephemeral db migrated
  PASS  认领到 assistant streaming 轮
  … 跑真 claude 流式（经代理），稍候
  PASS  流式分片落库 (5 片)
  PASS  assistant 消息 status=done
  PASS  最终 body 非空: "你好！我看到你的消息是「Reply」，但没有具体的任务内容。..."
  PASS  分片拼接与最终 body 一致
  PASS  会话写回 claude_session_id: 82d79ffc
  PASS  只读工作树已创建
  PASS  只读：origin/main 无新提交
✓ cleaned up

ALL PASS
```

→ matrix WS-02 / WS-03 / WS-04 PASS。真 claude 流式逐片落 `conversation_message_chunks`（本次 5 片），收尾拼成 `body` + `status=done` + `claude_session_id` 回写；对话在 `origin/main` 的只读工作树里跑，**未向 origin 推任何提交**。

## 过程中修正（均为测试 harness，非产品）

1. **getPool() 指向共享库**：`executeConversationTurn` 内部用 db 包 `getPool()` 单例（读 `DATABASE_URL`），首跑打到共享 dev 库（无 017 表）报 `relation conversations does not exist`。迁移后把 `process.env.DATABASE_URL` 指到临时库（首次 getPool() 前）修复。
2. **DROP 强杀单例池连接**：`getPool()` 单例对临时库留空闲连接，`DROP DATABASE WITH (FORCE)` 强杀它 → 池抛未处理 `error`（57P01）。DROP 前先 `closePool()` 修复。

## typecheck

`npm run typecheck`（db/console/worker 三包）全绿。

## 已知约束（写入 spec）

- 流式用**直接 spawn** claude（`--output-format stream-json`），不走 worker 的「终端 / 前置命令」形态（避免包裹噪声污染 NDJSON）。因此对话所需的**代理 / 环境**须在 **worker 进程 env** 里（而非仅靠终端前置命令）。
