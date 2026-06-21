# 任务 token 用量：记录 + 列表展示 + 升降序排序

## 需求
记录任务开发时使用的 token 用量，在任务列表中展示，并支持按 token 用量升/降序排序。

## 方案
token 用量天然分散在每轮 `claude --output-format json` 的 `usage` 里（首轮 / 续接 / 重试 / 执行中留言注入都各产一份），
故采用「Worker 逐轮解析 → 累加进 tasks 专列」的方式，用专列而非塞进 `result` jsonb，使 SQL `ORDER BY` 排序干净可索引。

- **总量定义**：单轮总用量 = `input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`，
  跨轮 / 跨重试在 DB 侧逐次累加（最忠实「这个任务一共用了多少 token」）。

## 改动（file:line 见 git diff）
1. **迁移** `packages/db/migrations/034_task_total_tokens.sql`：tasks 新增 `total_tokens bigint NOT NULL DEFAULT 0`（带 `COMMENT ON`）。
2. **类型** `packages/db/src/types.ts`：`Task.total_tokens: number`（pg bigint 返回字符串，listTasks 统一转 number）。
3. **查询** `packages/db/src/queries.ts`：
   - 新增 `SortField = "created" | "tokens"`，`ListTasksFilters.sort`；
   - `listTasks` 的 `ORDER BY` 走列 + 方向双白名单（tokens 排序以 `created_at DESC` 作次级键，让大量同 0 任务稳定有序）；
   - 行映射把 `total_tokens` 转 number；
   - 新增 `incrementTaskTokens(client, taskId, workerId, delta)`（`claimed_by` 守卫，与 `setTaskClaudeSession` 一致）。
4. **Worker** `apps/worker/src/executor.ts`：
   - `parseClaudeJson` 多解析 `usage`，`ClaudeTurn` 多带 `tokens`，新增 `sumUsageTokens`；
   - `runTaskClaude`（4 个产生 turn 的调用点的唯一收口）在每轮 turn 解析后 best-effort 累加（失败只 `console.warn`、不阻断已完成执行）。
5. **Console API** `apps/console/app/api/tasks/route.ts`：读 `sort` query（白名单 created/tokens，默认 created）传入 listTasks。
6. **Console UI** `apps/console/app/ui/shared.tsx` + `tasks.tsx`：新增 `fmtTokens`（1.2k/3.4M 缩写）；任务列表新增「Token」列，
   表头点击在 created/tokens 间切列、同列再点切方向（箭头只在当前排序列显示）。

## 验证
- `npm run typecheck` / `npm run build`：五包全绿（含 next build，/tasks 路由构建通过）。
- `node scripts/ephemeral-db.mjs --verify`：干净库跑全量迁移（034 应用成功）+ verify:console 见 401→200、`scheduler.ok:true`、`db.ok:true`。
- `node docs/acceptance/task-token-usage/scripts/verify-token-sort.mjs`：DB 级断言 sort=tokens 升/降序、与 created 排序互相区分、
  total_tokens 回 number、incrementTaskTokens 累加 + claimed_by 守卫 no-op。详见 `report.md` / `round-1.md`。
