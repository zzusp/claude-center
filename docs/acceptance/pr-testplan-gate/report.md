# 验收报告 — PR 产出优化（全绿）

matrix.csv 全 PASS（round-1）。结论：两项需求均已实现并验证。

## 需求 1：Claude Output 改为 Markdown 渲染

`prBody`（`apps/worker/src/executor.ts:474`）去掉 ```` ```text ```` 围栏，正文直接是 Claude 的 Markdown
产出，GitHub 正常渲染标题 / 列表 / 链接。原始任务需求收进 `<details>` 折叠块，末尾 Worker 署名脚注。

## 需求 2：标准 PR 结构 + Test Plan 自动合并门禁

- 契约（`apps/worker/prompts/center-rules.md`）要求 Claude 最终产出含 `## Summary` / `## Changes`
  （到 `file:line`）/ `## Test Plan`（checkbox：通过 `- [x]`、未通过 `- [ ] … ❌`、未测试 `- [ ]`）。
- `parseTestPlan`（`apps/worker/src/test-plan.ts`）解析 Test Plan：只有全部 case 打勾才 `allPassed`。
  8 个边界用例全 PASS。
- 门禁（`finalizeTaskMultiRepo`，`auto_merge_pr` 分支）：`allPassed` 才自动合并；否则不合并，落
  `auto_merge_blocked` 事件 + 发 `task_review_required` 通知给项目可见用户，任务保持 `success`，用户据
  通知决定手动合并或续接任务。
- 通知类型 `task_review_required`：迁移 035 扩约束并在真库验证「接受新类型 / 拒绝未知类型(23514)」；
  Console 铃铛与时间线均已登记标签 / 图标 / 配色。

## 验证强度说明

DB 改动用一次性临时库真值 round-trip；解析逻辑用 tsx 单测；typecheck/build 五包全绿。端到端
（真任务建 PR）受限于 worktree 未跑，已在 round-1.md「未覆盖」标注。
