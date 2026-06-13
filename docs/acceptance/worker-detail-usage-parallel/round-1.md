# Round 1 — 2026-06-14

环境：Windows 11，PowerShell 7，远程 dev 库 115.159.161.47:55432，本机 claude 2.1.177（Max 套餐）。

## C1 三层 typecheck + build — PASS
- `npm -w @claude-center/db run build` EXIT=0
- `npm -w @claude-center/worker run typecheck` EXIT=0；`build` EXIT=0
- `npm -w @claude-center/console run typecheck` EXIT=0；`build` EXIT=0，构建产物含路由 `ƒ /api/workers/[id]/working-state`

## C2 迁移应用 + 列存在 — PASS
- `npm run db:migrate` → `Applied 012_worker_detail_working_state.sql`
- information_schema 校验 6 列均在：allow_remote_control(boolean)、claude_version(text)、max_parallel(integer)、subscription_type(text)、usage(jsonb)、working_state(text)

## C3 DB 查询行为（scripts/db-queries.mts，事务 ROLLBACK）— PASS
```
[register] working_state(默认应 idle): idle | allow: true | max: 3 | sub: unknown | claude_version: null
[updateInfo] claude_version: 2.1.177 | sub: max | usage: {"five_hour":{...,"utilization":13}} | active_task_count: 0
[remote set working, allow=true] updated应true: true | runtime: {"working_state":"working","max_parallel":3}
[remote set, allow=false] updated应false: false | runtime仍working: {"working_state":"working",...}
[local set idle] updated应true: true | runtime: {"working_state":"idle",...}
[done] ROLLBACK，未污染共享库
```
要点：新 worker 默认 idle ✓；远程切换在 allow=false 时被拒（0 行）✓；本地切换不受限 ✓；active_task_count 派生 ✓。

## C4 采集链路（本机 inspectClaude 实跑）— PASS
```
[inspect] claudeVersion: 2.1.177
[inspect] subscriptionType: max
[inspect] usage: { five_hour:{utilization:26, resets_at:...}, seven_day:{utilization:34, resets_at:...} }
```
版本解析、凭据订阅判定、oauth/usage（经代理 curl）三条全通。

## C5 worktree 隔离（scripts/worktree-isolation.mts，临时 git 仓库）— PASS
```
[fresh] .git存在: true | 带出base文件: true | 分支: work/abc
[concurrent] 第二棵独立工作树: true | 路径不同: true
[isolate] 改动只在工作树, 主仓无 b.txt: true
[recover] 复用已存在工作树: true
[remove] wt2 已拆: true
[gc] 空 keep 回收孤儿: true
[gc-keep] keep 含该任务则保留: true
```
同项目两棵工作树并发独立 ✓，改动隔离 ✓，复用/移除/GC 回收与保护均符合预期。

## 旁路发现（未在本次修改）
`apps/worker/src/executor.ts` 的 `git commit -m <含空格消息>` 与 `gh pr create --title/--body <含空格>` 经 runCommand 在 Windows `shell:true` 下会被 cmd 重新分词（实测 `commit -m "wt change"` 报 `pathspec 'change' did not match`）。这是既有行为、与本特性无关；本次未改（遵循「不顺手改旁边代码」），留作反馈。
