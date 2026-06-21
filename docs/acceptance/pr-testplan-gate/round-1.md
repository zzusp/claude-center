# Round 1 — 全绿

环境：worktree `worktree-64ce9631...`，Windows 11 / PowerShell 7。DATABASE_URL 取自父检出 `.env`，
所有 DB 验证均在一次性临时库进行（用完 `DROP ... WITH (FORCE)`），零污染共享 dev 库。

## parseTestPlan 单测

`node_modules/.bin/tsx docs/acceptance/pr-testplan-gate/scripts/verify-parse-testplan.mts`

```
PASS  全部打勾 → 放行  -> found=true allPassed=true 2/2
PASS  含未测试（空 checkbox）→ 拦截  -> found=true allPassed=false 1/2
PASS  含未通过（❌）→ 拦截  -> found=true allPassed=false 1/2
PASS  打勾但带 ❌（自相矛盾）→ 该条判未通过  -> found=true allPassed=false 0/1
PASS  无 Test Plan → found=false → 拦截  -> found=false allPassed=false 0/0
PASS  Test Plan 后接其它标题 → 不误收后续 checkbox  -> found=true allPassed=true 1/1
PASS  大小写 [X] + 星号 bullet + 大写标题  -> found=true allPassed=false 1/2
PASS  CRLF 换行  -> found=true allPassed=true 2/2

All 8 cases PASS
```

## 迁移 035 + 约束 round-trip

`node docs/acceptance/pr-testplan-gate/scripts/verify-notification-constraint.mjs`

```
PASS  约束 notifications_type_check 存在
PASS  约束含类型 task_claimed … task_review_required … worker_offline（8/8）
PASS  引导 admin 用户存在（FK 用）
PASS  INSERT type=task_review_required 成功
PASS  INSERT type=bogus_type 被拒（23514）

✓ dropped database cc_constraint_check_...
All constraint assertions PASS
```

## 全量迁移链

`node scripts/ephemeral-db.mjs` → `applied 035_notification_review_required.sql` → `✓ migrations applied`
→ `✓ dropped database claude_center_ephemeral_...`。

## typecheck / build

- `npm run typecheck` → 五包（db / relay-client / console / worker / relay）全过，无 error。
- `npm run build` → 五包全过；console `next build` 产出全部路由（含 `/tasks/[id]`）。

## 未覆盖（说明）

- 真实「任务完成 → 建 PR → 渲染 + 门禁 + 通知」端到端未跑：需 Worker 接真任务 + GitHub 仓 + 远程
  Claude，超出本 worktree 能力。门禁判定逻辑（parseTestPlan）与通知落库（约束）已分别用真值验证；
  `prBody` 为纯字符串拼接，去围栏改动直观。
