# PR 产出优化：Markdown 渲染 + Test Plan 自动合并门禁

## 背景与目标

任务完成后 Worker 自动建 PR（`apps/worker/src/executor.ts` 的 `finalizeTaskMultiRepo` → `prBody`）。
现状两个问题：

1. **PR body 的「Claude Output」被包进 ```` ```text ```` 代码块**——GitHub 渲染成纯文本块，
   Claude 产出的 Markdown（标题 / 列表 / 链接）全部失效，可读性差。
2. **PR 缺乏标准结构**，没有强制的 Summary / Changes / Test Plan，reviewer 无法快速判断改了什么、
   验证了什么；`auto_merge_pr` 开启时只看 GitHub 的 `mergeable`，**不看测试是否真的通过**，可能把
   未验证 / 验证失败的改动直接合并。

目标：

- PR body 直接渲染 Markdown（去掉代码围栏）。
- 约定 Claude 的最终产出为标准 PR 描述：`## Summary` + `## Changes`（到 `file:line`）+
  `## Test Plan`（GitHub checkbox 列表，通过打勾 / 未通过打叉 / 未测试留空）。
- `auto_merge_pr` 开启时，Worker 解析 Test Plan：**只有全部 case 打勾（通过）才自动合并**；
  存在「未通过 / 未测试」case 时不合并，落事件 + 给用户发通知，交用户决定手动合并还是继续任务。

## 设计

### 1) Claude 产出契约（`apps/worker/prompts/center-rules.md`）

`center-rules.md` 经 `--append-system-prompt-file` 注入所有任务轮次。新增一节，要求 Claude 在
**任务完成时**的最终消息（即 `claude --output-format json` 的 `result`，被 Worker 用作 PR body）
必须是结构化 PR 描述：

- `## Summary`：改了什么、为什么，散文式。
- `## Changes`：bullet 列表，每条带 `path:line`（或 `path:Lstart-Lend`）。
- `## Test Plan`：GitHub 任务列表，一条 checkbox 一个验证用例：
  - 通过：`- [x] <case>`
  - 未通过：`- [ ] <case> ❌`
  - 未测试：`- [ ] <case>`
- 明确告知：**只有打勾的 case 才算「已验证通过」**；任一 case 未打勾（未通过或未测试），Worker 不会
  自动合并、会通知发起人。

求助哨兵（`<<CLAUDE_CENTER_NEEDS_INPUT>>`）流程不受影响——那条路径在 finalize 之前短路，不会走 PR。

### 2) PR body 渲染（`prBody`）

去掉 ```` ```text ```` 围栏，直接把 `claudeOutput`（Markdown）作为正文主体，原始任务需求收进
`<details>` 折叠块，末尾加 Worker 署名脚注。`claudeOutput` 为空时给占位文案兜底；显示侧对超长
内容截断（GitHub PR body 上限 65536 字符），**Test Plan 解析用未截断的全量文本**，门禁不受显示截断影响。

### 3) Test Plan 解析 + 自动合并门禁（`parseTestPlan` + `finalizeTaskMultiRepo`）

`parseTestPlan(output)` 纯函数：定位 `## Test Plan` 标题（大小写不敏感，到下一个标题结束），收集
checkbox 行（`- [ ] / - [x]`）。判定单条「通过」= 勾选 `[x]` 且不含失败标记（❌/✗/FAIL）。返回
`{ found, total, passed, items, allPassed }`，`allPassed = found && passed === total`。

门禁置于 `finalizeTaskMultiRepo` 的 `if (task.auto_merge_pr)` 内、`tryAutoMergeAllOrNone` 之前：

- `allPassed === true` → 照常 `tryAutoMergeAllOrNone`（再叠加 GitHub `mergeable` 的强一致检查）。
- 否则 → **不合并**，落 `auto_merge_blocked` 事件（带 total/passed/未通过 case 摘要）+ 发
  `task_review_required` 通知给项目可见用户。任务保持 `success`（PR 已建待人工处理），用户可手动合并或续接。

`auto_merge_pr=false` 时不涉及自动合并、无门禁、无通知（用户本就手动决策）。

**不可合并也通知（追加需求）**：`tryAutoMergeAllOrNone` 在 PR `mergeable` 检查不过（冲突 / CI 未过等）
时，原先只落 `auto_merge_skipped` 事件；现同样发 `task_review_required` 通知（与门禁共用
`notifyReviewRequired`），链到主仓 PR。同族事件 `auto_merge_skipped` 也补登记到 Console 时间线
`EVENT_META`。两路（Test Plan 未过 / PR 不可合并）跳过自动合并都通知用户人工裁决。

### 4) 通知类型 `task_review_required`

复用既有通知中心（DB `notifications` 表 + 顶栏铃铛）。新增类型 `task_review_required`：

- 迁移 `035_notification_review_required.sql`：重建 `notifications_type_check` 约束加入新类型 + 更新列注释。
- `packages/db/src/types.ts`：`NotificationType` 加 `task_review_required`。
- `packages/db/src/queries.ts`：`emitTaskNotification` 的 `Extract<>` 入参类型纳入新类型。
- `apps/console/app/ui/notifications.tsx`：`TYPE_LABEL` / `iconFor` / `toneFor` / `SOUND_TYPES` 登记。
- `apps/console/app/ui/task-detail-shared.tsx`：`EVENT_META` 登记 `auto_merge_blocked` 事件标签。

## 影响面

| 文件 | 改动 |
| --- | --- |
| `apps/worker/prompts/center-rules.md` | 新增「最终产出 = 结构化 PR 描述」契约 |
| `apps/worker/src/executor.ts` | `prBody` 渲染 Markdown；新增 `parseTestPlan`；finalize 加 Test Plan 门禁 + 通知；import `emitTaskNotification` |
| `packages/db/migrations/035_notification_review_required.sql` | 新增迁移：扩 CHECK + 注释 |
| `packages/db/src/types.ts` | `NotificationType` 加 `task_review_required` |
| `packages/db/src/queries.ts` | `emitTaskNotification` 入参类型纳入新类型；注释更新 |
| `apps/console/app/ui/notifications.tsx` | 新通知类型 UI 登记 |
| `apps/console/app/ui/task-detail-shared.tsx` | `auto_merge_blocked` 事件标签 |

## 验证

- `parseTestPlan` 纯函数：`scripts/verify-parse-testplan.mts` 用 tsx 跑 fixture 用例（全勾 / 含未勾 /
  含 ❌ / 无 Test Plan / 多标题边界）断言 `allPassed`。
- 迁移 035 + 约束 round-trip：`scripts/verify-notification-constraint.mjs` 一次性临时库验证「含 8 类型 /
  接受 task_review_required / 拒绝未知类型(23514)」。
- **端到端**：
  - `scripts/e2e-finalize-gate.mjs`（确定性）：真 `finalizeTaskMultiRepo` + 真 git push（临时 bare origin）
    + 真临时库 + 假 gh（node.exe + `--require fake-gh-hook.cjs`）。三场景：全通过→自动合并、未测试→拦截+通知、
    不可合并→跳过+通知；并断言 PR body 渲染 Markdown（无 ```text 围栏、含结构化段）。
  - `scripts/e2e-real-claude-contract.mjs`（真模型）：真 `executeTask` 跑真实 claude，断言其产出含
    `## Summary` / `## Changes`(file:line) / `## Test Plan`(checkbox)。
- `npm run typecheck`、`npm run build` 五包全绿。证据见 `docs/acceptance/pr-testplan-gate/round-1.md`、`round-2.md`。
