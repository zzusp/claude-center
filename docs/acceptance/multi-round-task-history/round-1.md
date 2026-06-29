# Round 1 — 多轮任务累计（多轮 PR body / 执行结果 / PR 列表）

> spec: [docs/spec/multi-round-task-history.md](../../spec/multi-round-task-history.md)
> 实现：`packages/db/src/queries.ts:markTaskSuccess + continueTask` · `apps/worker/src/executor.ts:prBody+finalizeTaskMultiRepo+finalizeNonGitTask` · `apps/console/app/ui/task-detail-overview.tsx:ResultPanel+ResultRoundList+ResultRoundCard` · `apps/console/app/globals.css:.ov-result-round*` · `packages/db/migrations/039_tasks_result_rounds.sql`

## 实跑证据

### 1) typecheck（五包绿）
```
> npm run typecheck
@claude-center/db / relay-client / console / worker / relay  全部 tsc --noEmit 通过（无输出 = 无错误）
```

### 2) build（五包绿）
```
> npm run build
@claude-center/db / relay-client / console / worker / relay  全部 tsc/next build 通过
```

### 3) DB 端 smoke：rounds[] 累计行为
```
> node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-multi-round-result.mts
✓ 首轮 markTaskSuccess → rounds[0] 落库（round=0/output/prUrls/completedAt/submitMode 齐全）
✓ 第二轮 markTaskSuccess → rounds[1] append；首轮内容完整保留
✓ 第三轮 markTaskSuccess → rounds[2] append（含多仓 prUrls）；前两轮完整保留
✓ push 模式：submitMode='push' + prUrls=[]
all multi-round result accumulation behaviors verified
```

### 4) 现有续跑 smoke 未回归（验证 continueTask 改动）
```
> node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-task-continuation.mts
✓ continueTask(success) → claimed + count=1 + 评论与事件落库
✓ claimNextContinuationTask(success) → running + continuation_started 事件
✓ getPendingContinuationNote(success) → 拼到本轮 user 评论
✓ continueTask(merged) + worker 模拟 case B：分支 -cont-1 已切，PR 已清
✓ guard: draft / running / failed 任务发起续跑均返回 null
✓ guard: 空 continuation_note 抛错
✓ 多轮续跑: continuation_count 单调递增，note 按本轮锚点取
✓ getTaskStatusById: 现状状态 / 不存在均按预期
✓ TOCTOU: success → continueTask → claimed; 二次校验命中 KEEP_AFTER_RECHECK
all continuation behaviors verified
```

### 5) 迁移整体跑通（含 039）
```
> node scripts/ephemeral-db.mjs
applied 001_init.sql .. 038_task_continuation.sql .. 039_tasks_result_rounds.sql
✓ migrations applied
```

### 6) Console UI 端到端截图
脚本：`scripts/take-multi-round-screenshot.mjs`（自包含：建临时库 → 跑迁移 → 种 3 轮成功任务 → 起 console dev → playwright 登录 + 截图 → cleanup）

输出：
- `round-1/task-detail-multi-round.png` — 默认状态（最近一轮展开 + 前两轮折叠）
- `round-1/task-detail-multi-round-all-open.png` — 三轮全展开

观察要点（截图均符合）：
- 标题「执行结果摘要（共 3 轮）」
- 第 2 轮续跑卡：默认展开；含两条 PR URL（主仓 + 子仓）；Markdown 渲染正常
- 第 1 轮续跑卡 / 首轮卡：默认折叠，点击展开后含「本轮 PR」+ output
- 每轮卡内的「纯文本 / 放大」工具栏沿用现有 ResultSummary 组件
- 时间戳显示「1 分钟前」（fmtAgo），title 属性显示完整 ISO 时间

## 行为差异（用户视角）

1. **PR body**：续跑产出的 PR 上 reviewer 能在 GitHub 页面看到本轮 + 历轮的完整内容（折叠区），每轮附该轮的 PR URL（旧 PR 也可见）。
2. **Console 执行结果**：任务详情「执行结果」区按轮展示卡片，「共 N 轮」一目了然，最近一轮默认展开。
3. **历史 PR 列表**：每轮卡片直接挂出该轮 PR 链接，不再需要翻 task_events 时间线推断。

## 兼容性

- 旧任务 `tasks.result` 无 `rounds` 字段 → UI fallback 到 `claudeResult`（与改造前形态一致），不破坏既有展示。
- `continueTask` 续跑时保留 `rounds[]`，旧任务首次续跑后下一轮 `markTaskSuccess` 时 rounds 从 `[]` 起，本轮 append 成 1 条；后续累计正常。
- 迁移 `039` 不动 schema，仅更新 `COMMENT ON COLUMN tasks.result`，并行分支可同时跑。
