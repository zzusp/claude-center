# 验收报告：会话同步 + 提交 shell 修复 + 工作树迁移（全绿）

`matrix.csv` 全 PASS（round-1）。

## 关键证据

- **根因纠正（点1）**：失败任务 DB `error_message` 显示 `pathspec 'task:' did not match`——非目录问题，是 commit message 被 cmd 按空格拆散。本机 `spawnSync` 实测：`shell:true → ["ClaudeCenter","task:","hello","world"]`（拆散），`shell:false → ["ClaudeCenter task: hello world"]`（完整）。修复后 `verify.mts` 的 A 用例用同款调用 `git commit -m "ClaudeCenter task: 发布 1.0.4 版本 (a b)"` 成功，`git log -1 --format=%s` 等于完整 message。
- **工作树迁移 + 主仓干净（点2）**：`worktreePathFor(repo, id)` = `<repo>/.claude/worktrees/worktree-<id>`；`ensureWorktree` 建成后主仓 `git status --porcelain` 为空（`.git/info/exclude` 写入 `/.claude/worktrees/`）。
- **GC 安全**：`gcWorktrees(repo, {keep:[taskId]})` 删除非 keep 的 `worktree-<UUID2>`、保留 keep 的 `worktree-<taskId>`、不碰名为 `dev-feature`（非 UUID）的 Claude Code dev 树。
- **会话同步（点3）**：`encode(cwd)` 对真实 transcript 文件（`C--Users-...-worktrees-9f51616a-...`）实证完全吻合；`readSessionJsonl` 取到 `projects/<encode(cwd)>/` 内最新 `.jsonl`；`startTaskSessionSync().stop()` 把完整 transcript 强制写入 `task_sessions`，`getTaskSession` 取回一致。

## 门禁

- `npm run typecheck`：db/console/worker 全绿。
- `npm run build`：三包绿，`/api/tasks/[id]/session` 路由已注册。
- `node scripts/ephemeral-db.mjs --verify`：迁移 001–018 全量应用、`verify:console` 401→登录→200、db health ok。

## 复现

```powershell
node docs/acceptance/worker-session-jsonl/scripts/run.mjs   # A/B/C/D 一把梭（自建临时库→验证→删库）
node scripts/ephemeral-db.mjs --verify                       # 迁移链 + console 健康
```

## 未覆盖 / 盲点

- 未驱动真实 Electron GUI / 真 Claude 端到端跑一个任务（headless 限制）；`runTaskClaude` 的同步是对 `startTaskSessionSync` 直接单测覆盖，未在真任务流里跑。`gh pr create --title/--body` 的 shell 修复与 `git commit` 同走 `runCommand`，由 A 用例间接证明，未单独对 gh 实跑（需 GitHub 鉴权）。
- 迁移文件签名变更（worktree.ts 由 config→localPath）：`docs/acceptance/worker-detail-usage-parallel/scripts/worktree-isolation.mts`（历史归档脚本，不入构建）仍引旧签名，如复用需同步更新。
