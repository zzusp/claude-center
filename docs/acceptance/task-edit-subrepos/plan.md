# 编辑任务表单填写子仓（子项目）信息

## 需求

新建/修改任务的表单要能填写子项目（子仓）信息。

## 现状（改动前）

- **新建任务**（`apps/console/app/ui/tasks-compose.tsx`）：已有「子仓配置」段（`SubRepoConfigSection`），当所选项目含子仓时可逐仓勾选 + 配置 base/work/target 分支，提交时序列化到 `taskRepos` 一并入队。**已支持**。
- **修改任务**（`apps/console/app/ui/task-detail-edit-form.tsx`）：表单只有「基本信息 / 分支配置 / 执行选项 / 调度」四段，**没有子仓配置段**，保存时也不带 `taskRepos`。后端 `PATCH /api/tasks/[id]` 的 `update` 动作早已支持整批替换 `task_repos`（见 `route.ts:173-195`，注释还显式写了「编辑表单暂不带多仓 UI」），即**后端就绪、独缺前端 UI**。

## 方案（最小改动，复用既有组件）

1. `tasks-compose.tsx`：把 `SubRepoConfigSection`、`serializeTaskRepos` 由文件内私有改为 `export`，供编辑表单复用（与新建表单保持完全一致的子仓填写体验，不另写一份）。
2. `task-detail-edit-form.tsx`：
   - 拉 `/api/projects/{projectId}/repos`（取 `role==='sub'`）+ `/api/tasks/{id}`（取现有 `task_repos` 快照）。
   - 预填每个子仓的启用/分支状态：`sub_status!=='skipped'` 视为启用并沿用其三分支，否则回退子仓 `default_branch`。
   - 项目有子仓时渲染「子仓配置」段（复用 `SubRepoConfigSection`）。
   - 保存时把 `serializeTaskRepos(subStates)` 作为 `taskRepos` 随 `update` 一并 PATCH；项目无子仓则不带该字段（后端 `undefined` = 仅同步主仓行、保留原配置）。

## 不做

- 不动后端：`PATCH update` 的 `taskRepos` 整批替换逻辑、`buildTaskRepoInputs` 均已存在且正确。
- 不动新建表单逻辑（仅导出两个符号）。

## 验证

- `npm run typecheck` / `npm -w @claude-center/console run build`
- HTTP e2e（`scripts/e2e-edit-task-subrepos.mjs`）：临时库 + 起 console，走真实路由验证「编辑→启用子仓+自定义分支→落库；再禁用→回 skipped」。
