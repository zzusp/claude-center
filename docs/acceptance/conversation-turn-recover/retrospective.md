# 实时对话「无完整结果」假失败修复——复盘

> 关联 PR：#176（已 merged）。本文档不是 plan，是事后复盘，记三处技术真因 + 两次过程栽点 + 由此立的规约补丁，给下次写"对话轮收尾"或"PR Test Plan"的人留 ground truth。

## 1. 技术真因（3 条并修）

### 1.1 `findSessionFile` preferSessionId 快路径不校验 sinceMs

`apps/worker/src/session.ts:findSessionFile` 命中 `<preferSessionId>.jsonl` 直接 `return`，不核对它的 mtime/birthtime 是否落在 `sinceMs` 窗口内。

真实失败链路：

1. 上一轮 claude 成功 → `conversations.claude_session_id = X`、`X.jsonl` 落盘。
2. 本轮 worker 启 `claude -p --resume X --output-format json`。
3. 某些 claude 版本下，`-p --resume <id>` 会 **派生新 sessionId Y** 写 `Y.jsonl`，而非追加到 `X.jsonl`。
4. `findSessionFile` 快路径仍命中 `X.jsonl`（存在 + 没看时间），返回该旧 file。
5. `extractFinalAssistantText` 按 sinceMs 过滤 `X.jsonl`，过滤完为空。
6. `finalizeConversationFromSession` 返 false → `executeConversationTurn` 走兜底 → 无完整结果文案。

修复：快路径里同样核对 `mtime || birthtime ≥ sinceMs`，过期 file 落到扫描分支自然命中 `Y.jsonl`。

### 1.2 `shell.runCommand` 的 `stdoutLogFile` open 失败静默退化

`apps/worker/src/shell.ts` 在 `openSync(file, "a")` 失败时直接 `logFd = null` 不发声，spawn 退化为 `stdio:'ignore'`，丢掉 claude `--output-format json` 的全部 stdout/stderr。已知诱因：OneDrive / antivirus 抢锁致 EBUSY/EPERM、Windows 长路径超 MAX_PATH、目录被并发删等。

修复：`console.warn` 出真因 + 文件路径，至少让排障的人能看到"是不是 stdoutLogFile 根本没打开"。

### 1.3 runner 重连/重启路径不读 stdoutLogFile

`finalizeOrFailReconnect` / `reattachConversationTurn.done()` 在 `finalizeConversationFromSession` 返 false 时直接 `failConversationTurn`，丢弃 stdout 文件里 claude 已经写好的 `{result, session_id}`——而 executor live 路径已经会 recover 一次。两条路径一致不能保证，停机期间跑完的轮会被强判失败。

修复：抽出 `tryRecoverConversationTurnFromClaudeLog(pool, {conversationId, messageId, wtPath})`，executor live 路径 + runner 两条重连路径共用同一段 recover，路径计算用 `conversationTurnClaudeLogPath(wtPath, turnId)` 锁死位置。

## 2. 过程栽点（2 次反复）

### 栽点 1：「需真生产 worker 才能 e2e」是错觉

第一轮提交时把 Test Plan 写成：

> - [ ] 真生产 worker 上复现「派生新 sessionId」场景挽回成功 — 需要触发一次同对话的 `--resume` 派生才能贴端到端证据；当前 e2e 已通过单元级镜像覆盖

用户原话："又来？e2e又不跑？连着三次了！" 翻 PR #175，发现这正是上次立硬线的反例。本仓 e2e 工具栈早就备齐：

- `scripts/mock-claude-echo.cjs` 模拟 claude
- `scripts/run-smoke-against-ephemeral.mjs` 包一个临时干净库 + tsx 跑 smoke
- `scripts/smoke-conversation-cancel.mts` 范本：用 `@claude-center/db` 的 helper 推状态机，跟真 worker 走同一份代码

本仓 worker ↔ console 的契约就是 DB（DB 唯一权威 + 双向轮询，CLAUDE.md 明文写过），"端到端需真 worker"几乎都是错觉——只要 import worker 的 helper（如 `finalizeConversationFromSession` / `tryRecoverConversationTurnFromClaudeLog`）就跟真 worker 在可观察契约上等价。

第二轮整改：写 `scripts/smoke-conversation-finalize-recover.mts`，ephemeral 干净库 + 真 worker helper 跑通 3 case：

- **A**：jsonl 缺 + stdout 写完整 JSON → recover 把 turn 翻 done
- **B**：preferSessionId 指 stale file + scan 候选 fresh file → 快路径回退、命中 fresh、turn 翻 done
- **C**：jsonl + log 全无 → 两 helper 全返 false、状态守恒不误判 done

跟生产 worker 跑同一份代码，3 case 全过。

### 栽点 2：可选 case 跳过得说清楚，否则 reviewer 蒙

第二轮把那个未跑 case 删了、补了 3 case e2e。用户进一步指出：

> 如果其他 case 已经能够 100% 确认验收通过，那么是允许跳过可选的 case 的，不过这种情况必须要说清楚，不然会给 review pr 的人一种 case 没有全部通过的认知。

这是对 Test Plan 写法的规约——不是要求加新 case。教训：

1. PR body 上的 `- [ ]` 必须旁边注一句"为什么剩下没跑就够"，不能空 checkbox 让 reviewer 猜。
2. Test Plan 顶部加一行 summary："本轮 e2e 覆盖范围 / 跳过项与等价覆盖"，让 reviewer 不必逐行读才能看出"是不是全过了"。
3. 默认倾向跑掉而不是省事跳过——本地 ephemeral + 真 helper 几乎没有跑不动的 case。

第三轮 PR body 顶端补了**覆盖说明**段，明确说明"未跳过任何可选 case + ephemeral smoke 跟生产 worker 走同一份代码 + 线上灰度不在本地 PR 阶段证据范围"。

## 3. 规约补丁去向

memory：`feedback-e2e-must-try-first.md` 已扩"栽点 3：可选 case 跳过得说清楚"——下次写 Test Plan 自动走"顶部 summary + 每个 `[ ]` 必须注理由"。

## 4. e2e 资产位置

- `scripts/verify-session-targeting.mjs` —— 6 case，含 preferSessionId stale 回退（Windows-safe 用真实时序差，因为 Windows 上 birthtime 改不了）
- `scripts/verify-conversation-turn-claude-log.mjs` —— 7 case，路径计算 + recover 兜底语义
- `scripts/verify-claude-json-recovery.mjs` / `scripts/verify-final-assistant-text.mjs` —— 修复前已有，本次未动，作为回归保护
- `scripts/smoke-conversation-finalize-recover.mts` —— **真 DB-level e2e**，必须经 `scripts/run-smoke-against-ephemeral.mjs` 起临时库跑

## 5. 未来变更注意

- 改 `findSessionFile`：`preferSessionId` 快路径的"sinceMs 校验"和扫描分支的"sinceMs 校验"必须保持同语义（`mtime || birthtime`），否则二者会重新分叉。`scripts/verify-session-targeting.mjs` case 6 就守这条。
- 改 `shell.runCommand` 的 stdout fd 流程：`logFd = null` 的兜底要保留 warn 真因；改回静默会让"无完整结果"假失败的诊断又消失。
- 改 `finalizeConversationFromSession` 或 `tryRecoverConversationTurnFromClaudeLog`：runner reattach 两处 + executor live 一处都必须同步走 recover；否则停机重连和实时跑的语义会再次分叉。`scripts/smoke-conversation-finalize-recover.mts` Case A 守 recover、Case B 守 fast-path 回退。
