# Round 1 — 任务详情页重设计验证

环境：worktree `worktree-task-detail-redesign`，npm workspaces，dev 库（远程共享）。

## 1. typecheck — PASS
`npm -w @claude-center/console run typecheck` → tsc 无输出、退出 0。

## 2. build — PASS
`npm -w @claude-center/console run build` → `✓ Compiled successfully`，路由表含：
```
└ ƒ /tasks/[id]                          6.85 kB         109 kB
```

## 3. 多形态渲染（已存在任务）— PASS
脚本 `scripts/verify-detail-render.mjs`：起 `next start` → admin 登录 → 取 overview.tasks 按 (类型:状态) 去重 → 逐个 GET `/tasks/<id>`，断言 200 + 含 `detail-hero/lifecycle-bar/lc-step/detail-grid/section-title/返回任务流` + 不含 `class="tabs"`。

```
sampledCombos: work:failed, work:claimed, work:cancelled, work:pending, work:success, work:running
全部 http=200, ok=true, missingMarkers=[], hasOldTabs=false
work:success → hasReview=true（验收区仅 success 出现）
notFoundStatus: 404
allPass: true
```

## 4. 补充形态（临时创建→验证→清理）— PASS
dev 库原本无 qa / draft / scheduled 任务，脚本 `scripts/verify-detail-states.mjs` 临时创建三条 → 验证 → pg 直连删除。
（前置：dev 库缺 migration 014 的 `auto_merge_pr` 列，`npm run db:migrate` 对齐后通过。读取路径不受影响——`SELECT tasks.*` 缺列即 undefined、UI 渲染为「否」。）

```
draftWork  draft     hasMarkers ✓ hasPublish ✓ hasBranchInfo ✓ isQa=false
qa         draft     hasMarkers ✓ hasPublish ✓ hasBranchInfo=false hasChat ✓ isQaLabel ✓
scheduled  scheduled hasMarkers ✓ hasPublish ✓
pass: true
cleanup: deleted 3, remaining 0
```

## 盲点 / 未覆盖
- **像素级视觉外观**：无头环境未截图，依赖 CSS 复用既有设计 token（grid/flex/stepper 标准布局）保证；建议本地 `npm run dev:console` 肉眼终检。
- merged/accepted/rejected/waiting 状态：dev 库无对应数据，未单独实跑；这些仅影响 lifecycle 文案与状态徽章，不改双栏布局，逻辑与改前一致。
