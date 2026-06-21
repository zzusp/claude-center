# Round 2 — 端到端补齐 + 两项追加需求（全绿）

承接用户反馈：① 不要跳过可做的端到端验证；② 顺手登记同族事件 `auto_merge_skipped`；
③ 不可合并导致跳过自动合并也要发用户通知。本轮新增两个真·端到端测试，并验证 ②③。

## 追加改动

- `apps/worker/src/executor.ts`：抽 `notifyReviewRequired` 共用；`tryAutoMergeAllOrNone` 的不可合并分支
  在 `auto_merge_skipped` 事件外**新增 `task_review_required` 通知**（需求③）；导出 `finalizeTaskMultiRepo`
  作端到端测试入口。
- `apps/console/app/ui/task-detail-shared.tsx`：`EVENT_META` 登记 `auto_merge_skipped`（需求②）。

## E2E-1：finalize 门禁（确定性，真产品代码 + 真 git + 真库 + 假 gh）

`node docs/acceptance/pr-testplan-gate/scripts/e2e-finalize-gate.mjs`

走的产品路径：`finalizeTaskMultiRepo` → 真 `git commit/push`（推到临时 bare origin）→ gh 用 node.exe +
`--require fake-gh-hook.cjs` 假冒（gh 首参 `pr` 无短横，node 解析为主模块名，hook 在加载前拦截并 exit）。
真 PG 临时库（用完 DROP）。三场景全绿：

```
=== pass-mergeable ===   committed → pushed → pr_created → success → auto_merged
  gh: list,create,view,merge   notifs: task_pr_created,task_success
  ✓ pr_created ✓ auto_merged ✓ 无 blocked/skipped ✓ gh merge 调用 ✓ 未发待确认通知
  ✓ PR body 不含 ```text 围栏（需求1）✓ 含 ## Summary/## Test Plan ✓ 含折叠原始需求
=== untested-blocked ===  committed → pushed → pr_created → success → auto_merge_blocked
  gh: list,create   notifs: task_pr_created,task_review_required,task_success
  ✓ pr_created ✓ auto_merge_blocked ✓ 未合并 ✓ 门禁在 view 前拦下 ✓ 发 task_review_required
=== unmergeable-notify === committed → pushed → pr_created → success → auto_merge_skipped
  gh: list,create,view   notifs: task_pr_created,task_review_required,task_success
  ✓ pr_created ✓ auto_merge_skipped ✓ 未合并 ✓ 查 view 但未 merge
  ✓ 不可合并也发 task_review_required（需求3）
✓ 端到端全部断言通过
```

## E2E-2：真实模型产出契约（真 claude）

`node docs/acceptance/pr-testplan-gate/scripts/e2e-real-claude-contract.mjs`

完整入口 `executeTask` 跑**真实 claude**（submit_mode=push，无需 gh），证 center-rules.md 的契约让真模型
产出结构化 PR 描述。真实产出（24s）：

```
## Summary
在仓库根目录新建了 `HELLO.md`，写入单行内容 `hello world`。…
## Changes
- `HELLO.md:1` — 新建文件，内容为一行 `hello world`
## Test Plan
- [x] `HELLO.md` 存在于仓库根目录（`ls -l HELLO.md` → 12 字节）
- [x] 文件内容为 `hello world`（`cat HELLO.md` 输出一致）
```

断言全过：status=success；claudeResult 含 `## Summary` / `## Changes`（带 `file:line`）/ `## Test Plan` /
GitHub checkbox；自身不是 ```text 代码块。

## typecheck / build

`npm run typecheck` 五包全过；`npm run build` 五包全过（console next build 7/7 页）。

## 关于 round-1 的「未覆盖」

round-1 标注的端到端未覆盖项，本轮已用 E2E-1（确定性，覆盖门禁/通知/PR body 渲染）+ E2E-2（真模型，
覆盖产出契约）补齐。
