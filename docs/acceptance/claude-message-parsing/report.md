# Report — Claude Code 消息解析优化

13/13 PASS（详见 `matrix.csv` + `round-1.md`）。

## 改动一句话

- **skill 加载误显示为用户消息**：`parseTranscript` / `extractFinalAssistantText` / 桌面端 `txIsMetaEntry` 一律过滤 `isMeta:true` 或 `<command-name>/<local-command-caveat>/<system-reminder>` 起首的伪 user 行。
- **定时消息回显另一个终端的历史**：`findSessionFile` 加 `sinceMs`（本次 claude 启动时刻，排除同 cwd 里别的终端 claude 留下的旧 .jsonl）+ `preferSessionId`（DB 留存的 `conversations.claude_session_id`，命中 `<id>.jsonl` 直接锁定），贯穿 `executeConversationTurn` 与重启重连路径。
- **后台进程跟踪**：jsonl 解析提取 `Bash run_in_background:true` 派发 + `attachment.queued_command` 完成回执；SessionMetaBar 与桌面端会话面板都加"后台 N"指示，悬浮列前 8 条命令描述。

## 一键复现

```powershell
node --import tsx docs/acceptance/claude-message-parsing/scripts/e2e-message-parsing.mts
```

## 顺手改进

- 把 `parseTranscript / extractBackgroundJobs / isMetaUserEntry` 从 `transcript.tsx`（"use client" + 重 React 依赖）抽到 `transcript-parse.ts`（纯函数 / 零 React），让 e2e 能直接 import 真函数 + 未来加更多解析规则也好挂单测；`transcript.tsx` re-export 保持现有 import 路径无破坏。
