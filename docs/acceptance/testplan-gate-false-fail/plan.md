# Test Plan 门禁误判：用例描述含英文 "failed" 被错拦自动合并

## 症状

任务 `a262645f-994f-4e2b-a153-91c4b6e9c725`（PR #144）开启「是 · 创建后自动合并」，PR 的
Test Plan 8 个 case 全部 `- [x]` 勾选（全通过），但未自动合并。DB `task_events` 实证：

```
auto_merge_blocked :: Test Plan 7/8 通过，存在未通过 / 未测试项，已跳过自动合并，待人工裁决
payload={"found":true,"total":8,"passed":7,
         "failing":["C runCommand 非零退出（真 curl）：`error.message` 不含明文 token、
                     仍含 `Command failed: curl ... Bearer ***`"]}
```

被判失败的 case C 明明是 `- [x]`（勾选 = 通过），却被算进未通过项 → `allPassed=false`
→ 走 `blockAutoMergeForTestPlan` 而非 `tryAutoMergeAllOrNone`。

## 根因

`apps/worker/src/test-plan.ts` 的失败标记正则：

```ts
const FAIL_MARK = /[❌✗✘]|\bFAIL(?:ED|ING)?\b/i;   // 旧
```

`\bFAIL(?:ED|ING)?\b` 大小写不敏感地匹配英文单词 fail / failed / failing **出现在 label 任意位置**。
case C 的描述里有「仍含 `Command **failed**: curl ... Bearer ***`」——这是在描述一条断言
（错误文案应保留 `Command failed` 上下文、仅脱敏 token），属正常文案，却命中了 `\bFAILED\b`，
于是勾选项被反判为失败。

契约（`apps/worker/prompts/center-rules.md` / 本任务系统提示）里失败项的唯一记号是
`- [ ] <case> ❌`（叉号），从未把英文单词 "fail" 当失败信号。词匹配是过度防御，与契约不符，
且 test case 描述天然高频出现 fail / failed / fails（"Command failed"、"assert it fails"、
"failing input"），必然误伤。

## 修复

`apps/worker/src/test-plan.ts:21` —— 失败标记只保留契约约定的叉号，删掉英文词匹配：

```ts
const FAIL_MARK = /[❌✗✘]/;   // 新
```

叉号 ❌/✗/✘ 不会出现在正常中英文描述里，安全；勾选 + 叉号自相矛盾的项仍判未通过（防御意图保留）。

**与用户确认的规则一致**：本质即「checkbox 状态是唯一真值——只勾选通过项，失败 / 未验证一律不勾选」。
契约 `apps/worker/prompts/center-rules.md:31-40` 早已如此约定（Passed→`[x]`、Failed→`[ ] ❌`、
Not run→`[ ]`，且「Only a checked box counts as verified passing」），case C 本就是通过项且正确勾选，
错的是旧解析器拿描述文本里的英文词二次猜测。修复后解析只认 checkbox 状态，与契约 / 用户规则对齐。

## 验证

- `npx tsx docs/acceptance/pr-testplan-gate/scripts/verify-parse-testplan.mts` —— 9 用例全 PASS
  （新增回归：勾选项描述含英文 failed/fails 仍判通过）。
- 用任务 a262645f 的 `claudeResult` 全文跑修复后 `parseTestPlan`：`total=8 passed=8 allPassed=true`
  （旧逻辑为 7/8）——证明该任务在新代码下会放行自动合并。
- `npm -w @claude-center/worker run typecheck`、`npm -w @claude-center/worker run build` 绿，
  编译产物 `dist/test-plan.js` 正则为 `/[❌✗✘]/`。

> 注：运行中的 Worker 是长驻进程、按已编译 dist 服务；本修复随 Worker 重新构建 + 重启后对新任务 /
> 重跑生效。当前 PR #144 的旧判定结果不会因源码改动自动改变（需更新版 Worker 重跑或人工合并）。
