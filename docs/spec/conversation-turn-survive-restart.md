# 桌面对话轮「关机存活 + 重启重连」（Option B）

## 目标

桌面 worker 处理实时对话、claude 正在生成时，用户关闭桌面端 → claude **后台继续跑完**；重开桌面端 → **重连**该轮：进程还活着就实时回显并在退出后收尾；停机期间已跑完就直接从 transcript 收尾。**不重跑、不重复**（这是相对 Option A「resume 重跑」的关键优势——重跑会把 prompt + 答案再写一遍进 jsonl）。

## 实测依据（docs/tmp/proc-test）

- 当前 `spawn(claude, {shell:false})`（无 detached）：**父进程退出即被杀**（Electron 父和普通 Node 父都杀，Windows 通用行为）。
- `spawn(..., {detached:true, stdio:"ignore"})`：**存活到自己跑完**（实测跑满全程）。
- → detached 是让 claude 熬过关机的唯一开关；终态无法靠已断的 stdout，必须从 `.jsonl` 重建（文件持久、且本就同步进 DB 供展示）。

## 设计

### 1. 进程模型
- 对话轮的 claude 改 `detached:true, stdio:"ignore"` 启动（`executor.executeConversationTurn`）。worker 在世时仍持句柄、`await` 其 `exit`；worker 退出时 claude 不被杀、继续写 `.jsonl`。
- spawn 后立即把 **pid + worktree cwd** 持久化到该 streaming 轮（`conversation_messages.claude_pid / claude_cwd`，迁移 030）。crash 窗口（spawn 与持久化之间）极小，落不到就按「已退」处理。

### 2. 收尾一律从 .jsonl 重建
- `finalizeConversationFromSession(cwd)`：`result` = jsonl 末条 assistant 文本，`sessionId` = `.jsonl` 文件名。复用现有 `finalizeConversationTurn`（加终态守卫 `WHERE status IN ('streaming','pending')`，防覆盖 cancelled）。
- 正常路径（worker 在世）：`await` claude exit → exit 0 则 finalize-from-session，否则 `failConversationTurn`。

### 3. 重启对账（`runner.reconcileInflightConversationTurns`，替代旧 `recoverOrphanedConversationTurns`）
对本机名下每条 in-flight（streaming/pending）assistant 轮：
- `claude_pid` 仍存活（`process.kill(pid,0)` 不抛 / EPERM）→ **重连**：占住对话车道、恢复 `startConversationSessionSync`、轮询 pid；pid 消失即 finalize-from-session（除非已被取消）。Console 端继续显示「回复中」。
- 否则（pid 已退/未记）→ jsonl 有完整本轮 assistant 结果就 finalize-from-session，否则 `failConversationTurn("worker 重启时该轮进程已退出且无完整结果")`。

### 4. 取消兼容
- `conversationActive` 加 `pid` 字段。`handleConversationCancellations`：有 child 句柄走 `killProcessTree(child)`；重连轮无句柄走 `killByPid(pid)`（新增，Win `taskkill /T /F /PID`，POSIX 杀进程组）。
- 重连轮的 pid 轮询在退出时，若 `active.cancelled` 则跳过 finalize（cancelled 终态已落）。

### 已知边界 / 取舍
- **pid 复用**：进程退出后 pid 可能被别的进程复用，`process.kill(pid,0)` 会误判存活。桌面端重连通常发生在重启后短时内，复用概率低；不额外存进程启动时间做强校验（标注，不治理）。
- **完整性判定**：重启后无 exit code，只能靠「jsonl 末条是本轮 assistant」启发判完成；claude 中途崩可能误判。可接受（partial 仍可见，最坏 fail）。
- **用量**：停机期间 claude 继续跑会持续消耗 claude 用量——通常正是预期。

## 改动面
- `packages/db/migrations/030_conversation_turn_process.sql`（+ COMMENT ON）
- `packages/db/src/{types,queries}.ts`：`ConversationMessage` 加 `claude_pid/claude_cwd`；`setConversationTurnProcess` / `listInflightConversationTurnsForWorker`；`finalizeConversationTurn` 加终态守卫
- `apps/worker/src/shell.ts`：`killByPid` + `isProcessAlive`
- `apps/worker/src/session.ts`：`extractLastAssistantText` / sessionId 取文件名（或在 executor）
- `apps/worker/src/executor.ts`：detached 启动 + 持久化 pid + finalize-from-session
- `apps/worker/src/runner.ts`：`reconcileInflightConversationTurns` + `reattachConversationTurn` + 取消按 pid

## 验证
- typecheck/build；迁移对一次性干净库 apply。
- **重连逻辑隔离测**（不跑真 claude）：用 proc-test 式假长跑进程冒充 claude，seed 一条 streaming 轮（claude_pid=假进程 / claude_cwd=含假 jsonl 的目录），跑对账：
  - 假进程**存活** → 断言重连（轮保持 streaming、车道占住）；杀掉假进程 → 断言 finalize-from-session（轮→done、body 取自 jsonl）。
  - pid **已退 + 完整 jsonl** → 断言 finalize done；pid 已退 + 空/残缺 jsonl → 断言 fail。
- detached 存活已由 proc-test C 证实。
