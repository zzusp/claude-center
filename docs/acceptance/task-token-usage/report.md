# 验收报告 — 任务 token 用量（记录 + 展示 + 排序）

状态：**全绿**（2026-06-21）

## 验证项与证据

| # | 验证项 | 命令 | 结果 |
|---|--------|------|------|
| 1 | 五包类型检查 | `npm run typecheck` | PASS（db / relay-client / console / worker / relay 全绿） |
| 2 | 五包构建（含 next build） | `npm run build` | PASS（/tasks 路由 8.52 kB 构建通过） |
| 3 | 迁移 034 在干净库应用 + 控制台启动 | `node scripts/ephemeral-db.mjs --verify` | PASS（`applied 034_task_total_tokens.sql`；401→200；`scheduler.ok:true`；`db.ok:true`；用后 DROP） |
| 4 | 排序 + 累加 DB 级断言 | `node docs/acceptance/task-token-usage/scripts/verify-token-sort.mjs` | PASS（8/8 断言，见下） |
| 5 | **真·端到端（真实 claude CLI 跑真任务）** | `node docs/acceptance/task-token-usage/scripts/e2e-executor.mjs` | PASS（真 claude 一轮 → `total_tokens=77901` 落库 → 任务 success → 改动推到 origin；见下） |

## 第 4 项断言明细（脚本实跑输出）

种子：3 个任务，created 与 token 用量故意错位（t1 旧/500，t2 中/120000，t3 新/0），以区分两种排序列。

```
  ✓ sort=tokens desc → t2,t1,t3
  ✓ sort=tokens asc → t3,t1,t2
  ✓ sort=created desc → t3,t2,t1
  ✓ sort=created asc → t1,t2,t3
  ✓ total_tokens 是 number
  ✓ t2.total_tokens === 120000
  ✓ 0+1000+250=1250            （incrementTaskTokens 逐次累加）
  ✓ 非认领 worker 累加 no-op，仍 1250  （claimed_by 守卫）
```

## 第 5 项真·端到端明细（脚本实跑输出）

走的就是产品代码路径：`apps/worker/dist/executor.js` 的 `executeTask` → `spawnClaude`（真 `claude.exe` 2.1.183）
→ `runTaskClaude` → `parseClaudeJson` 解析 `usage` → `sumUsageTokens` → `incrementTaskTokens` 落库
→ finalize commit/push 到本地 bare origin → `markTaskSuccess`。零污染（临时 PG 库 + 临时 git 仓，结束 DROP + 删目录）。

```
任务终态：status=success, total_tokens=77901, error=—
事件时间线：running → worktree_prepared → deps_primed → claude_turn_finished → committed → pushed → success
  ✓ total_tokens 已记录且 > 0（实际 77901）
  ✓ 任务走到 success
  ✓ 事件含 claude_turn_finished（claude 真跑过一轮）
  ✓ 事件含 pushed（改动已直推 origin）
  ✓ listTasks 返回 number 型 total_tokens=77901
  ✓ origin/main 顶部提交来自 worker（"ClaudeCenter task: token e2e"）
  ✓ origin/main 含 claude 新建的 E2E.md
```

> 此前 report 标注的盲点「真实 claude usage 解析未端到端验证」已由本项闭环：真 claude 一轮跑出 77901 token 并正确累加落库、被 listTasks 以数值返回。

## 范围说明
- 仅主任务列表（TasksView）加了 Token 列与排序；worker 详情页 / dashboard 近期任务列表未改（不在需求范围）。
