# Round 3 — 现存 PR 仍显示代码块的根因 + 正文随重跑刷新

用户反馈：当前 PR（#140）的「Claude Output」**仍是 markdown 代码块**，质疑是否真修好。

## 根因（ground truth）

`gh pr view 140 --json body` 实测 #140 正文确为旧格式：`## Request` / `## Worker Evidence` /
`## Claude Output` + ```` ```text ```` 围栏。两条原因叠加：

1. **建 #140 的 Worker 跑的是旧编译产物**。Worker 是长驻 Node 进程，启动时一次性加载 `executor.js`；
   源码 / dist 改了不会热加载到在跑的进程。#140 是改动合并 + Worker 重建重启前由旧 `prBody` 建的。
2. **PR 正文原仅在 `gh pr create` 写一次**（`executor.ts` create 分支），打回重跑走「复用已存在 PR」
   分支时**不刷新正文**（`executor.ts:884` / `:893` 两处 reuse 直接 continue）。故 #140 正文被冻结在
   首轮内容，即便修复上线也不会自己变。

修复本身是对的（已验证）：源码 `prBody` 无 ```text、渲染 Markdown；`apps/worker/dist/executor.js`
重建后同样是新逻辑；round-2 的 `e2e-finalize-gate.mjs` 跑**真实编译产物**断言建 PR 的 `--body` 无围栏。

## 追加修复：复用分支刷新正文（`refreshPrBody`）

`executor.ts` 两处 reuse 分支新增 `gh pr edit <prUrl> --body <prBody(...)>`（best-effort）：
更新版 Worker 下一轮 finalize 该任务时，会把旧格式 PR 正文刷成渲染后的 Markdown；多轮迭代正文也不再过时。

## 端到端（`e2e-finalize-gate.mjs`，新增场景 4）

真 `finalizeTaskMultiRepo` + 真 git push + 真临时库 + 假 gh。四场景全绿：

```
pass-mergeable      gh: list,create,view,merge   → auto_merged，PR body 无 ```text、含结构化段
untested-blocked    gh: list,create              → auto_merge_blocked + task_review_required
unmergeable-notify  gh: list,create,view         → auto_merge_skipped + task_review_required（需求3）
reuse-refresh       gh: edit,view,merge          → 未重复 create；gh pr edit 刷新正文为渲染 Markdown；照常门禁合并
✓ 端到端全部断言通过
```

`npm run typecheck` / `npm run build` 五包全绿。

## 给用户：怎样让 #140 不再显示代码块

- 合并本 PR → 重新构建并重启桌面 Worker（使其加载新代码）。
- 之后：**新任务**的 PR 一开始就是渲染 Markdown；**本任务 #140**会在更新版 Worker 下一轮 finalize 时被
  `gh pr edit` 刷新为新格式。我（Claude）不会直接改线上 PR（PR 由 Worker 拥有、且属外部可见写操作）。
