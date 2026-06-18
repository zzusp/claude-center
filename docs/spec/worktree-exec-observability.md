# worktree 执行可观测性 + 启动效率优化

## 背景 / 症状

任务 `50ac12e8`（消息默认显示条数）在 Console 上长时间停在「开始执行」里程碑，疑似卡死。排查（查 task_sessions transcript ground truth）结论：**没卡死，claude 在正常执行**，但暴露三个问题：

1. **里程碑视图无执行期反馈**：worker 用单次阻塞调用 `claude -p ... --output-format json`（`executor.ts:927`，超时 60min），整轮跑完前不发任何 task_event、`claude_session_id` 也要等返回后才写。概览/进度里程碑因此整段冻结在「开始执行」，光看里程碑无法区分「在跑」与「卡死」（唯一实时信号是每 20s 同步的 transcript，只在「Claude Code 执行」tab 渲染）。
2. **claude 前 ~5.5 分钟在读主检出而非 worktree**：claude 派的 Explore 子代理返回了主检出绝对路径 `D:\project\claude-center\...`（而非 worktree `…\.claude\worktrees\worktree-<id>\…`），claude 照着读了 ~5min 才自纠。根因：(a) `taskPrompt` 只说「Work directly in the current repository」、从没把 claude 钉在 worktree；(b) worktree 物理嵌套在主仓内（`worktree.ts:19-24`），主仓根是 cwd 的祖先，宽搜索/路径解析易落到主检出同名文件。
3. **worktree 不预热依赖**：`prepareRepoWorktree`（`executor.ts:431`）只 `git fetch` + `ensureWorktree`，不装依赖；每个任务里 claude 都要现学现装 node_modules（本次 01:14:35 自己起的 setup）。

## 改动方案

### 改动 1：把 claude 钉在 worktree（解 §2，最高杠杆）
`executor.ts`：新增 `worktreeAnchor(wtPath)` 段，注入 `taskPrompt` / `resumePrompt` / `retryPrompt` 顶部，明确：你在 worktree `<wtPath>`，这是唯一工作目录，禁止读/搜/改其外（父检出 off-limits），优先相对路径。三处 prompt builder 加 `wtPath` 入参，调用点已有 `wtPath` 可传。

### 改动 2：概览存活信号（解 §1，问题1）
- `packages/db`：新增 `getTaskSessionSyncedAt`（只取 synced_at，不拖 blob，留作他用）。主路径用下面端点。
- `apps/console/app/lib/transcript-summary.ts`（server 安全、无 React）：解析 session jsonl → `{ lastActivityAt, toolCount, lastStep }`。
- `apps/console/app/api/tasks/[id]/session/progress/route.ts`：读 task_sessions blob → 返回上面 compact 摘要（不回传 blob）。
- `task-detail-overview.tsx`：任务在途（claimed/running/waiting）且未到「执行结束」时，5s 懒轮询该端点，在「进度」卡渲染一行「执行中 · 最近活动 Xs 前 · 已 N 步 · 当前:…」。终态/非在途不轮询。

### 改动 3：worktree 预热依赖（解 §3，问题2-②）
`executor.ts` `prepareRepoWorktree`：`ensureWorktree` 后，若该仓 worktree 根有 `package.json` 且无 `node_modules`，best-effort 跑 `npm install --prefer-offline --no-audit --no-fund`（`shell:true` 走 npm.cmd，windowsHide）。失败不阻塞任务（emit `deps_primed` 事件记结果：installed/skipped-exists/skipped-no-pkg/failed）。通用判定，不写死 claude-center 专属 setup 脚本（worker 跑任意项目）。resume/retry 复用 worktree 时 node_modules 多已在 → 自动跳过。

## 验证

- `npm run typecheck`（五包）
- `npm run build`（含 next build）
- `npm run verify:console`（401→200 + scheduler.ok）
- transcript 解析器：用合成 jsonl 跑一次 `transcript-summary` 断言 toolCount/lastStep。
- ⚠️ worker 侧（改动 1/3）需真实 worker + claude 才能端到端验证执行；本地只能 typecheck/build 证明编译通过，端到端待用户 worker 验证（PR body 标注）。
</content>
