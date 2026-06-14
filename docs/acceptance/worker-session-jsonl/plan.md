# 验收：会话同步 + 提交 shell 修复 + 工作树迁移

## 症状

任务 `9f51616a-...-b172`（push 模式）执行完毕提交时失败：

```
git -C C:\Users\202309\.claude-center\worktrees\9f51616a-...-b172 commit -m ClaudeCenter task: 发布1.0.4版本
error: pathspec 'task:' did not match any file(s) known to git
error: pathspec '发布1.0.4版本' did not match any file(s) known to git
```

用户初判「找错目录/路径拼错」。

## 根因（已纠正初判）

不是目录问题——`-C <worktree>` 路径正确。真因：`shell.ts` 的 `runCommand` 默认 `shell:true`（Windows），Node 把含空格的参数拼进 cmd 命令行却不加引号，commit message `ClaudeCenter task: 发布1.0.4版本` 被 cmd 按空格拆成多 token。本机实测 `shell:true`→拆散、`shell:false`→完整。git/gh title/body 同受影响（push 模式先撞 commit）。

## 改动

| 文件 | 改动 |
| --- | --- |
| `apps/worker/src/shell.ts` | `runCommand` 默认 `shell:false`（git/gh/claude 标准安装均 .exe，实测可启动） |
| `apps/worker/src/worktree.ts` | 工作树根迁到 `<localPath>/.claude/worktrees/`，命名 `worktree-<taskId>` / `worktree-conv-<id>`；GC 严格只清 `worktree-<UUID>` 任务树；新增 `ensureWorktreesIgnored`（写主仓 `.git/info/exclude`）；`worktreesRoot`/`worktreePathFor`/`conversationWorktreePathFor`/`gcWorktrees` 改按 `localPath` |
| `apps/worker/src/executor.ts` | 调用点改传 `localPath`；新增 `runTaskClaude`（跑 claude + 周期/终态同步 session）替换三条任务执行路径的 `runClaudeJson` |
| `apps/worker/src/session.ts`（新） | 定位 `<CLAUDE_CONFIG_DIR\|~/.claude>/projects/<encode(cwd)>/<最新>.jsonl`、读全文、周期+终态同步 |
| `apps/worker/src/runner.ts` | `gcWorktrees` 调用去掉 config 参数 |
| `packages/db/migrations/018_task_session_jsonl.sql`（新） | 侧表 `task_sessions(task_id pk, jsonl, synced_at)` |
| `packages/db/src/queries.ts` | `upsertTaskSession` / `getTaskSession` |
| `apps/console/app/api/tasks/[id]/session/route.ts`（新） | GET 返回 `{ jsonl, syncedAt }`（鉴权+项目隔离） |
| `apps/console/app/ui/task-detail.tsx` | 「执行会话」Section + `SessionTranscript`（解析 NDJSON 回放，终态后停拉） |
| `apps/console/app/globals.css` | `.session-*` 样式 |

实现偏离说明：点3「加字段」改为 1:1 侧表 `task_sessions`——`tasks` 被 8+ 处 `SELECT tasks.*/SELECT *` 读取，加 TOAST 大文本列会拖垮所有列表/认领读路径；侧表功能等价、读路径不污染。

## 验证

见 `scripts/verify.mts`（自动断言 A 提交 / B 工作树+主仓干净+GC / C transcript 定位 / D DB 同步）+ `scripts/run.mjs`（一次性临时库编排）。门禁 `npm run typecheck` / `npm run build` / `node scripts/ephemeral-db.mjs --verify`。结果见 `matrix.csv` / `report.md`。
