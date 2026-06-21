# 验收：PR 产出优化（Markdown 渲染 + Test Plan 自动合并门禁）

设计见 `docs/spec/pr-body-testplan-merge-gate.md`。

## 需求

1. PR body 的「Claude Output」当前被包进 ```` ```text ```` 代码块 → 应直接渲染 Markdown。
2. PR 应含标准结构 Summary / Changes（到 `file:line`）/ Test Plan（checkbox：通过打勾 / 未通过打叉 /
   未测试留空）；Test Plan 存在未通过 / 未测试 case 时不自动合并，通知用户人工裁决。

## 方案 / 改动

- `apps/worker/prompts/center-rules.md`：新增「最终产出 = 标准 PR 描述（Summary/Changes/Test Plan）」契约。
- `apps/worker/src/executor.ts:474` `prBody`：去掉代码围栏，直接渲染 Claude 的 Markdown，原始需求收进
  `<details>`，加 Worker 署名脚注。
- `apps/worker/src/test-plan.ts`：新增纯函数 `parseTestPlan`（零依赖，便于单测）。
- `apps/worker/src/executor.ts:1010` 起：`finalizeTaskMultiRepo` 的 `auto_merge_pr` 分支前置 Test Plan 门禁
  —— `allPassed` 才走 `tryAutoMergeAllOrNone`，否则 `blockAutoMergeForTestPlan`（落 `auto_merge_blocked`
  事件 + 发 `task_review_required` 通知）。
- DB：迁移 `035_notification_review_required.sql` 扩 `notifications_type_check`；`types.ts` /
  `queries.ts` 纳入新通知类型。
- Console：`notifications.tsx`（TYPE_LABEL/icon/tone/sound）、`task-detail-shared.tsx`（事件标签）登记。

## 验证

| 项 | 命令 | 证据 |
| --- | --- | --- |
| parseTestPlan 8 个边界用例 | `npx tsx docs/acceptance/pr-testplan-gate/scripts/verify-parse-testplan.mts` | round-1.md |
| 迁移 035 + 约束接受/拒绝（真库round-trip，零污染） | `node docs/acceptance/pr-testplan-gate/scripts/verify-notification-constraint.mjs` | round-1.md |
| 全量迁移链应用到临时库 | `node scripts/ephemeral-db.mjs` | round-1.md |
| 五包 typecheck | `npm run typecheck` | round-1.md |
| 五包 build（含 next build） | `npm run build` | round-1.md |
