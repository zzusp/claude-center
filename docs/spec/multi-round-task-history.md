# 多轮任务累计：PR body / 执行结果 / 历史 PR 列表

> 任务被续跑（continuation）或打回重跑（rerun）多轮时，PR body、Console 执行结果区、历史 PR 列表三处都应当**累计每一轮**而非「只显示最新一轮」。

## 现状（改造前）

- `tasks.result.claudeResult` 仅存最新一轮 Claude 结构化输出，每轮 `markTaskSuccess()` 直接覆写。`apps/console` 的 `ResultPanel` 只读这个字段——续到第 N 轮时，前 N-1 轮的输出在 UI 中消失。
- `task_repos.pr_url` 仅记最新一条 PR：旧 PR 合并后 `continuation_branch_rotated` 走「切 -cont-N 新分支」路径，`updateTaskRepoBranchAndResetPr()` 直接把 `pr_url` 置 null，旧 PR URL 只留在 `task_events` 的 `continuation_branch_rotated` payload 里（每条 event 只记 oldPrUrl，跨多轮要回放整段时间线才能拼出全集）。
- `prBody()`（`apps/worker/src/executor.ts:658`）只渲染本轮 `claudeOutput`，加一行「续跑 #N」注脚——reviewer 在 GitHub 上看不到前几轮发生了什么。

## 目标

每轮跑完后，下面三处都能看到「截至本轮的全量历史」：

1. **PR body**：本轮内容置顶 + 历轮以可折叠区块列出，每段附该轮的 PR URL（哪怕已合并）。
2. **Console「执行结果」面板**：按轮分段展示每轮 output，每段附该轮 PR URL 链接。
3. **历史 PR 列表**：从 `tasks.result.rounds[]` 直接读出，无需翻 event payload。

## 设计

### 数据模型：在 `tasks.result` JSONB 内追加 `rounds[]`

不开新表（rounds 与 task 1:N 强绑、查询都 by task_id；JSONB 内嵌已够用，加表反而多 join）。`tasks.result` 现状 JSONB，无 schema 改动门槛。

新结构（向后兼容旧任务——旧 result 缺 `rounds` 时 UI fallback 到 `claudeResult`）：

```jsonc
{
  // 兼容旧字段（最新一轮的快照，UI 旧路径仍可读，不破坏旧任务展示）
  "workdir": "...",
  "submitMode": "pr" | "push",
  "claudeResult": "<最新一轮 output>",
  "multiRepo": [...],

  // 新字段：每轮累计 append
  "rounds": [
    {
      "round": 0,                     // == continuation_count at success time（0=首轮，1=第一次续跑）
      "output": "<本轮 claudeOutput>",
      "completedAt": "2026-06-29T12:00:00.000Z",
      "prUrls": ["https://github.com/.../pull/42"],
      "submitMode": "pr" | "push" | "none"
    }
  ]
}
```

**为什么保留 `claudeResult`**：旧任务的 `tasks.result` 没有 `rounds[]`，强行废掉旧字段会让 UI 在过渡期空白。保留即是「最新一轮快照」，新 UI 优先读 `rounds[]`，旧 UI 路径作为 fallback。后续可独立观察一段时间后再清。

### Append 语义放在 `markTaskSuccess()` 内部（queries.ts）

理由：`markTaskSuccess()` 是 `tasks.result` 唯一的写入口，read-modify-write 闭环放在这里语义最干净；worker 端调用方仅传本轮原料（output / prUrls / submitMode），不需要也不应该自己拼 `rounds[]` 数组。

签名扩展（新增第六参数 `round`）：

```ts
export async function markTaskSuccess(
  client,
  taskId,
  workerId,
  resultPayload: Record<string, unknown>,  // 含 claudeResult / multiRepo（保持向后兼容）
  prUrl: string | null,
  round: {
    output: string;
    prUrls: string[];        // 本轮所有 PR URL（pr 模式）或 [] （push / non-git）
    submitMode: "pr" | "push" | "none";
  }
): Promise<void> {
  // SELECT current result + continuation_count（claimed_by 锁定下无并发写，无需事务）
  // append round entry，UPDATE result
}
```

并发安全：`markTaskSuccess` 在 `WHERE id=$1 AND claimed_by=$2` 约束下，对同一 task 只有一个 worker 串行执行（claim 是排他的）。read-modify-write 不会与其他写竞态。

### `prBody()` 渲染策略

签名扩展：

```ts
function prBody(task: Task, claudeOutput: string, previousRounds: RoundEntry[]): string
```

`previousRounds` 来自调用前 `SELECT result FROM tasks WHERE id=$1`（在 finalize 路径开始处取一次即可，三个 prBody 调用点共享）。

渲染结构：

```markdown
{claudeOutput}                              ← 当前轮放最上方，reviewer 一打开就看到本轮变化

---

<details>
<summary>历史轮次（N 轮）</summary>

### 第 N 轮 · 2026-06-29 12:00
**本轮 PR**：https://github.com/.../pull/42
{output}

### 第 N-1 轮 · 2026-06-29 10:00
...

</details>

---

<details><summary>原始任务需求</summary>
{task.description}
</details>

<sub>🤖 ClaudeCenter task {id}</sub>
```

字符数预算（GitHub 65536 上限）：当前 `PR_BODY_OUTPUT_CAP=55000`、`PR_BODY_REQUEST_CAP=8000`。历轮加入后需再压：当前轮保留 `PR_BODY_OUTPUT_CAP / 2`，历轮共享另一半（按轮平分，超长每轮单独截断）。极端长任务的累计长度可能溢出——溢出时从最旧的轮开始 drop，并在 details 里注明「N 轮历史，已省略最旧 M 轮（GitHub PR body 长度上限）」。

### Console `ResultPanel` 渲染策略

新逻辑（`apps/console/app/ui/task-detail-overview.tsx:301`）：

1. 读 `task.result?.rounds`，若是非空数组 → 按 `round` 升序渲染每轮卡片：
   - 标题：`第 N 轮 · {完成时间相对值}`（首轮显示「首轮」）
   - 内容：`<ResultSummary summary={output} />`（沿用现有 Markdown 渲染）
   - 底部：「本轮 PR」链接列表（点击跳 GitHub）
2. 若 `rounds` 缺失/空（老任务向后兼容）→ 沿用旧路径读 `task.result?.claudeResult`。

UI 上多轮折叠：默认展开「最近一轮」，更早轮次折叠（`<details>` 包住）。

### 历史 PR 列表（无需新增独立组件）

`rounds[]` 中每轮的 `prUrls` 即历史 PR——`ResultPanel` 渲染每轮卡片时直接列出，不再单开一个「PR 历史」section。旧任务的历史 PR 仍可从 `continuation_branch_rotated` 事件 payload 反查（事件保留不动，不丢历史）。

## 迁移

`packages/db/migrations/039_tasks_result_rounds.sql`：

- 不修改 schema（JSONB），仅更新 `COMMENT ON COLUMN tasks.result` 文档化新结构，列出 `rounds[]` 子字段。
- 不回填历史任务的 `rounds[]`（旧任务保留 `claudeResult`，UI fallback 兼容；强行回填会丢失中间轮信息）。
- 不影响并行分支（只动 comment，不动结构 / 约束）。

## 验证

1. `npm run typecheck` + `npm run build`：五包绿。
2. `npm run db:ephemeral`：临时库跑全量迁移含 039，断言 `COMMENT ON COLUMN tasks.result` 命中新字符串。
3. `scripts/smoke-task-continuation.mts` 已覆盖续跑流程；新增一条断言：第二轮 `markTaskSuccess` 后 `tasks.result.rounds.length === 2`、`rounds[1].round === 1`、`rounds[0].output` 是首轮内容、`rounds[1].output` 是第二轮内容。
4. `apps/console` playwright + `take-screenshots.mjs` 风格脚本：双轮任务种子库 → 截 `ResultPanel` 渲染两轮的截图，确认每轮卡片均展示且 PR URL 链可点击。
5. `prBody()` 单元用例：传 `claudeOutput="新一轮"` + `previousRounds=[第0轮, 第1轮]`，断言输出含「第 2 轮置顶 + 第 1 轮 + 第 0 轮 details」。

## 不在本期范围

- Worker 桌面端（`apps/worker`）UI 改造：Worker 自身不渲染「历轮总结」，主要展示「当前轮状态」，本期不动。
- 历史任务 backfill：旧任务 `rounds[]` 仍缺，UI 走 fallback 路径，不影响功能。
- `prBody()` 自动 i18n / 语言切换：保持中文标题，与现有「续跑 #N」一致。
