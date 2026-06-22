# Round 1 —— Test Plan 门禁误判修复验证

## C1 parseTestPlan 单测（含回归用例）

`npx tsx docs/acceptance/pr-testplan-gate/scripts/verify-parse-testplan.mts`

```
PASS  全部打勾 → 放行  -> found=true allPassed=true 2/2
PASS  含未测试（空 checkbox）→ 拦截  -> found=true allPassed=false 1/2
PASS  含未通过（❌）→ 拦截  -> found=true allPassed=false 1/2
PASS  打勾但带 ❌（自相矛盾）→ 该条判未通过  -> found=true allPassed=false 0/1
PASS  勾选项描述含英文 failed/fails → 仍判通过（回归）  -> found=true allPassed=true 3/3
PASS  无 Test Plan → found=false → 拦截  -> found=false allPassed=false 0/0
PASS  Test Plan 后接其它标题 → 不误收后续 checkbox  -> found=true allPassed=true 1/1
PASS  大小写 [X] + 星号 bullet + 大写标题  -> found=true allPassed=false 1/2
PASS  CRLF 换行  -> found=true allPassed=true 2/2

All 9 cases PASS
```

## C2 真实任务 a262645f 全文回放

取 `task_events` 里 success 事件的 `claudeResult` 全文，跑修复后 `parseTestPlan`：

```
found=true total=8 passed=8 allPassed=true
PASS C runCommand 非零退出（真 curl）：`error.message` 不含明文 token、仍含 `Command failed: curl ...
... (其余 7 条均 PASS)
```

对照旧逻辑：DB 实证 `auto_merge_blocked` payload 为 `{total:8, passed:7, failing:["C ..."]}`。
修复后 case C 不再被误判 → `allPassed=true` → 该任务会走 `tryAutoMergeAllOrNone` 放行自动合并。

## C3 / C4 类型 + 构建

```
npm -w @claude-center/worker run typecheck   # tsc --noEmit 绿
npm -w @claude-center/worker run build       # tsc 绿
grep FAIL_MARK apps/worker/dist/test-plan.js # const FAIL_MARK = /[❌✗✘]/;
```

四项全 PASS，见 matrix.csv。
