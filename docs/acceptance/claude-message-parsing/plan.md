# Claude Code 消息解析优化（acceptance plan）

## 需求

用户原话：

> claude code的消息解析优化：
> 1. load skill时的结果会作为用户发送的信息展示出来，这应该是展示有误，分析原因。
> 2. 实时对话，设置好定时时间发送消息。消息到时间发送后，发现返回的消息记录是另一个之前打开的终端窗口中的历史，应该是找错session会话了吧
> 3. claude code有时会在主对话停下，等待主对话启动的后台进程执行完，后台进程执行完会唤醒主对话，我希望遇到这种情况时候，要知道主对话实际上还没结束，它在等待后台进程执行结束时唤醒。所以页面上最好能显示出来后台进程的存在，task中的claude code对话也是，如果有后台进程，那么就不是真正的执行结束。

## 改动（commit）

| # | 主题 | 关键文件 |
| --- | --- | --- |
| 1 | parseTranscript 过滤 `isMeta`/`<command-*>`/`<local-command-*>`/`<system-reminder>` 起首的伪用户消息 | `apps/console/app/ui/transcript.tsx`、`apps/worker/src/window-html.ts`、`apps/worker/src/executor.ts`（extractFinalAssistantText） |
| 2 | `findSessionFile` 加 `sinceMs` 时间窗 + `preferSessionId` 快路径；conversation 的 `claude_session_id` 与本次 claude 启动时间端到端贯穿到同步与收尾 | `apps/worker/src/session.ts`、`apps/worker/src/executor.ts`、`apps/worker/src/runner.ts` |
| 3 | jsonl 解析提取 `Bash run_in_background:true` 派发 + `attachment.queued_command` 完成回执；SessionMetaBar 与桌面端会话面板加"后台 N"指示 | `apps/console/app/ui/transcript.tsx`（extractBackgroundJobs / pendingBackgroundJobs）、`apps/console/app/ui/session-meta.tsx`、`apps/worker/src/window-html.ts` |

## 验证范围

### 解析层（pure 函数）

- 真实 session JSONL + 合成 fixture：`scripts/verify-transcript-parser.mjs`
- session 文件锁定逻辑：`scripts/verify-session-targeting.mjs`

### DB + 业务层

- `promoteDueScheduledConversationMessages` 把到点 scheduled 消息翻 done + 赋 seq
- `claimNextConversationTurn` 不会因「已 scheduled」漏掉到点的消息
- `upsertConversationSession` 接收新解析逻辑能识别的 jsonl

### UI 层（实地观察）

起 Console（指向 ephemeral DB），playwright 登入 admin → `/chat?c=<convId>`：

- 不应有「skill 文档全文 / `<command-name>` / `<local-command-caveat>`」的 user 气泡
- SessionMetaBar 应出现「后台 N」chip，悬浮提示列出 pending 命令描述
- assistant 正文应正常渲染

## 工作模式

`docs/acceptance/claude-message-parsing/` 下：
- `scripts/e2e-message-parsing.mjs`：单一 e2e 入口，建库 → 种数据 → 起 console → playwright 断言/截图 → 拆库
- `matrix.csv`：用例 × round 总表
- `round-1.md`：本轮验证记录与截图
- `round-1/screenshots/`：playwright 截图
- 全绿后 `report.md`
