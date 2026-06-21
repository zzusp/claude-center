# 验收报告 — 任务 token 用量（记录 + 展示 + 排序）

状态：**全绿**（2026-06-21）

## 验证项与证据

| # | 验证项 | 命令 | 结果 |
|---|--------|------|------|
| 1 | 五包类型检查 | `npm run typecheck` | PASS（db / relay-client / console / worker / relay 全绿） |
| 2 | 五包构建（含 next build） | `npm run build` | PASS（/tasks 路由 8.52 kB 构建通过） |
| 3 | 迁移 034 在干净库应用 + 控制台启动 | `node scripts/ephemeral-db.mjs --verify` | PASS（`applied 034_task_total_tokens.sql`；401→200；`scheduler.ok:true`；`db.ok:true`；用后 DROP） |
| 4 | 排序 + 累加 DB 级断言 | `node docs/acceptance/task-token-usage/scripts/verify-token-sort.mjs` | PASS（8/8 断言，见下） |

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

## 未覆盖（说明）
- **真实 claude 进程的 usage 解析**：本环境不便跑一次真任务，未做端到端真跑；`sumUsageTokens` / `parseClaudeJson`
  逻辑由 typecheck + 单元逻辑覆盖，依据 `claude --output-format json` 结果对象含 `usage`（input/output/cache 两类）的既定行为。
- 仅主任务列表（TasksView）加了 Token 列与排序；worker 详情页 / dashboard 近期任务列表未改（不在需求范围）。
