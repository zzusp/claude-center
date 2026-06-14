# Worker 会话记录同步 + 提交命令 shell 修复 + 工作树迁移

> 一次性处理三件相关事：① 修任务提交报错的真正根因；② 把任务/对话工作树迁到项目 `.claude/worktrees/` 下；③ 新增任务执行会话(transcript)同步 + web 渲染。

## 1. 点1：提交失败的真实根因（已纠正用户初判）

失败任务 `9f51616a-16ef-47f0-b5c9-980f4f11b172`（push 模式）报错（DB `error_message` 实证）：

```
git -C C:\Users\202309\.claude-center\worktrees\9f51616a-...-b172 commit -m ClaudeCenter task: 发布1.0.4版本
error: pathspec 'task:' did not match any file(s) known to git
error: pathspec '发布1.0.4版本' did not match any file(s) known to git
```

- **不是目录拼错**：`-C <worktree>` 路径完全正确，git 确实进到了那棵工作树。
- **真因**：`apps/worker/src/shell.ts` 的 `runCommand` 默认 `shell: options.shell ?? process.platform === "win32"` → Windows 下 `shell:true`。Node 把 args 用空格拼成命令行交给 `cmd.exe`，**含空格的参数不加引号**，被 cmd 按空格拆成多个 token：`-m` 只吃到 `ClaudeCenter`，`task:` / `发布1.0.4版本` 被 git 当成 pathspec。
- **本机实证**：`spawn(node,[...,"ClaudeCenter task: hello world",...])` —— `shell:true` → `["ClaudeCenter","task:","hello","world"]`（拆散）；`shell:false` → `["ClaudeCenter task: hello world"]`（完整）。
- **影响面**：所有经 `runCommand` 默认 shell 跑、且参数含空格的命令——commit message、`gh pr create --title/--body`（body 还含换行，cmd 根本无法承载）。claude 本身因走「终端形态」(经 env 传 prompt, shell:false) 或纯中文(无空格)而幸免，故只有 git commit 先暴露。
- 为何之前「跑得动」：用户配了代理 preCommand → claude 走终端形态；任务标题纯中文无空格；`noChanges` 路径不 commit。本次是首个「push 模式 + 有改动 + commit message 含空格前缀」落到 commit 的任务。

### 修复

`shell.ts:61` 默认改 `shell: options.shell ?? false`。依据：

- 本机 `git`(2.49)/`gh`(2.92)/`claude`(2.1.177, `~/.local/bin/claude.exe`) **均为真 .exe**，`shell:false` 实测可启动。
- 与代码本意一致：`spawnClaude` 注释已声明直接形态应「无 shell 解析，最稳」，此前只是漏传 `shell:false`。
- `shell:false` 走 CreateProcess，每个 arg 作为独立 argv 传入，空格/换行不被二次解析。
- 终端形态(line 140/143)与 `runPowerShell` 本就显式 `shell:false`，改默认后保持一致。
- **取舍**：`.cmd`/`.bat` 形态的 claude/gh（如 npm 全局 shim）在 `shell:false` 下 Node 会拒绝 spawn（CVE-2024-27980）。原生安装均为 .exe；代理场景走终端形态(在终端 shell 内跑 claude，`.cmd` 仍可)。在 shell.ts 注释里写清。

## 2. 点2：工作树迁到 `<项目>/.claude/worktrees/worktree-<id>`

用户定夺：**保留每任务 worktree 隔离**，但把树从全局 `~/.claude-center/worktrees/<taskId>` 迁到项目内 `<localPath>/.claude/worktrees/worktree-<taskId>`（与 Claude Code 原生 `.claude/worktrees/` 约定一致）。cwd 仍是该 worktree(在项目目录下)，session transcript 因而落在 `~/.claude/projects/<项目路径前缀>--claude-worktrees-worktree-<id>/`，挂在项目路径前缀下、紧邻项目普通 session。**不改 cwd 传递逻辑**，只改 worktree 建立位置。

### 改动（`apps/worker/src/worktree.ts`）

- `worktreesRoot(localPath)` = `path.join(localPath, ".claude", "worktrees")`（去掉 config，改为按项目）。
- `worktreePathFor(localPath, taskId)` = `worktreesRoot(localPath)/worktree-<taskId>`。
- `conversationWorktreePathFor(localPath, conversationId)` = `worktreesRoot(localPath)/worktree-conv-<conversationId>`。
- `gcWorktrees(localPath, keepTaskIds)`：root 改为 `worktreesRoot(localPath)`。**安全收窄**：只删 basename 严格匹配 `worktree-<UUID>`（任务树）且 UUID 不在 keepTaskIds 的；**不碰** Claude Code 自己的 dev 工作树(目录名为人类 slug，非 UUID)、不碰 `worktree-conv-*`、不碰其它。
  - 风险背景：迁入项目 `.claude/worktrees/` 后与 Claude Code dev 工作树同目录；旧 GC「删 root 下不在 keep 的一切」会误删用户在用的 dev 树。故用严格 UUID 模式作判别（任务/会话 id 是 UUID，dev 树名是 slug）。

### 调用点

- `executor.ts`：`worktreePathFor(config, …)`→`worktreePathFor(localPath, …)`（executeTask/resumeTask/rerunRejectedTask/cleanupMergedTask，localPath 均在作用域内）；`conversationWorktreePathFor(config, conv.id)`→`(localPath, conv.id)`。
- `runner.ts` `gcWorktrees(this.config, project.localPath, keep)`→`gcWorktrees(project.localPath, keep)`。

### git 干净性

工作树注册在主仓 `.git/worktrees`，git status 会跳过已注册的 linked worktree 目录（Claude Code 自身即如此），主仓不被弄脏。验证时实测确认。

## 3. 点3：任务执行会话 transcript 同步 + 渲染

### 存储：1:1 侧表（非 tasks 列）

用户原话「任务新增字段 session_jsonl」。**实现偏离说明**：`tasks` 已被 8+ 处 `SELECT tasks.* / SELECT *`（列表/认领/分页/merge 候选）读取，加一个 TOAST 大文本列会让所有这些读路径拖着整份 transcript（列表 N 条 × 数百 KB）。故存到 1:1 侧表（与 `conversation_message_chunks` 侧表模式一致），功能等价、读路径不被污染。若坚持要列再改回（trivial）。

迁移 `018_task_session_jsonl.sql`（018 在 origin/main 与所有 worktree-* 分支均空闲）：

```sql
CREATE TABLE IF NOT EXISTS task_sessions (
  task_id   uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  jsonl     text NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now()
);
```

queries：`upsertTaskSession(client, taskId, jsonl)`（ON CONFLICT 更新 + synced_at=now()）、`getTaskSession(client, taskId)`→`{ jsonl, synced_at } | null`。

### worker 同步（新 `apps/worker/src/session.ts`）

- transcript 落点：`<base>/projects/<encode(cwd)>/<sessionId>.jsonl`，`base = process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`，`encode = cwd.replace(/[^a-zA-Z0-9]/g,"-")`（已对真实文件实证完全吻合）。
- `readSessionJsonl(cwd)`：定位 `<base>/projects/<encode(cwd)>/` 下最新 `.jsonl`（cwd 每任务唯一→该目录即本任务会话），读全文返回 string|null。不需要预先知道 sessionId。
- `startTaskSessionSync(pool, taskId, cwd)`：`setInterval` 每 20s 读文件→`upsertTaskSession`（按长度单调增量跳过 no-op 写）；返回 `stop()`：clearInterval + **强制最终同步一次**（绕过长度守卫，保证终态拿到完整文件）。
- 包装 `runClaudeJsonWithSync(config, getPool(), taskId, opts)`：`try { runClaudeJson } finally { await stop() }`。executeTask/resumeTask/rerunRejectedTask 改用它。
  - claude 进程退出(成功/抛错/超时/被 kill 取消)→ await 落定 → finally 跑最终同步 → 再由 handleClaudeTurn/catch 翻终态。故 web 见终态时 transcript 已完整。覆盖「成功/失败/超时/取消」。
- 作用域：仅任务（对话已有 chunks/messages 全量落库，不在此列）。

### console 渲染

- queries `getTaskSession` + 路由 `app/api/tasks/[id]/session/route.ts`（GET，镜像 [id]/route 的鉴权+项目隔离）→`{ jsonl, syncedAt }`。**不**并入 `/api/tasks/[id]`(避免 5s 轮询拖大 blob)。
- `task-detail.tsx` 新增「执行会话」Section + `SessionTranscript` 组件：自有 `usePolling`（5s，终态且已加载后停拉）；解析 NDJSON，仅取 `user`/`assistant` 且带 `message` 的行，content 归一化 blocks(text/thinking/tool_use/tool_result)渲染，其余类型(ai-title/queue-operation/last-prompt/mode/attachment)跳过。

## 4. 验证计划

1. `npm run typecheck` 三包绿。
2. `npm run build` 三包绿。
3. shell 修复单测：tsx 脚本对临时 git 库跑 `runCommand("git",["commit","-m","ClaudeCenter task: 发布 1.0.4"])`，断言单条 commit 成功、`git log -1 --format=%s` == 完整 message。
4. 工作树迁移：tsx 脚本对临时主仓 `worktreePathFor` 落在 `<repo>/.claude/worktrees/worktree-<id>`，`ensureWorktree` 建成，主仓 `git status --porcelain` 仍干净（git 跳过注册的 linked worktree）；`gcWorktrees` 只删任务 UUID 树、保留同目录下名为 slug 的 dev 树。
5. session 同步：tsx 脚本造 `<base>/projects/<encode(cwd)>/<uuid>.jsonl`，`readSessionJsonl(cwd)` 取到全文；`startTaskSessionSync`→`stop()` 后 `getTaskSession` 拿到完整内容（对临时库）。
6. `npm run verify:console`：401→登录→200。
```
