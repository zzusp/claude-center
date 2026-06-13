# 任务详情：侧边抽屉 → 独立详情页

## 需求
任务流（总览「最近任务流」表格、任务调度列表）点击某一行后，原本从右侧滑出 `TaskDrawer` 抽屉展示详情。改为跳转到**独立路由详情页** `/tasks/[id]` 整页展示，带独立 URL（可复制分享、刷新/前进后退保留）。

## 现状（改前）
- 纯 state 驱动 SPA，`view` 是状态，无任何 URL 路由（`apps/console/app/ui/dashboard.tsx`）。
- 点击任务 → `openTask()` 设 `drawerOpen/drawerMode="detail"/openedTaskId` → 右侧 `TaskDrawer` 渲染 `TaskDetailBody`。
- 详情数据来自 `/api/overview` 3s 轮询（`overview.tasks`）+ 点击时快照；事件/评论各自 3s 轮询 `/api/tasks/[id]/events`、`/api/tasks/[id]/comments`。
- 无单任务查询接口；`GET /api/tasks/[id]` 不存在（只有 PATCH）。

## 方案
1. **db** `packages/db/src/queries.ts`：新增 `getTaskWithDeps(client, id)`，复用 `listRecentTasks` 的 SELECT（带 `project_name/depends_on/blocked`）加 `WHERE tasks.id=$1`，并解析前置任务 `{id,title,status}[]`。`export * from queries` 自动导出。
2. **API** `apps/console/app/api/tasks/[id]/route.ts`：新增 `GET`，`requireUser` + 非 admin 项目隔离（`getTaskProjectId`+`userHasProject`），返回 `{ task, predecessors }`。
3. **共享原子** 新建 `apps/console/app/ui/shared.tsx`：把 dashboard 私有的展示原子/工具上移——`Tone`、`STATUS_META`、`metaOf`、`postJson`、`fmtTime`、`StatusBadge`、`TaskTypeBadge`、`StatusDot`、`KvRow`、`Empty`。dashboard 与详情页共用。
4. **详情页组件** 新建 `apps/console/app/ui/task-detail.tsx`（client）：`TaskDetailPage`（整页布局 + 顶栏返回按钮 + tabs + 3s 轮询 `/api/tasks/[id]` 与 events）、`TaskConversation`、`TaskReviewActions`、`EVENT_LABEL`（从 dashboard 迁出）。
5. **路由页** 新建 `apps/console/app/tasks/[id]/page.tsx`（server）：`getCurrentUser` 未登录 `redirect("/login")`；非 admin 越权或任务不存在 → `notFound()`；`getTaskWithDeps` 取初始数据传给 `TaskDetailPage`。
6. **dashboard 改造**：`openTask` 改为 `router.push('/tasks/'+id)`；删除 detail 相关 state/抽屉分支（`TaskDrawer` 仅保留 compose 发布任务）；删除已迁出的组件/原子，改为从 `./shared` import；`TasksView` 去掉选中高亮 prop。
7. **CSS** `globals.css`：新增 `.detail-page*` 整页布局，主体复用既有 `.tabs/.tab-body/.kv/.timeline/.chat/.badge` 等。

## 验证
- `pnpm -C apps/console typecheck` / `pnpm -C packages/db build` 通过。
- `pnpm -C apps/console build` 通过（含新路由 `/tasks/[id]`）。
- 本地 `dev` 实跑：列表点任务跳详情页、URL 为 `/tasks/<id>`、刷新保留、返回回列表、四个 tab（概览/对话/时间线/日志）、发布/验收/回复动作正常、非授权跳转 login/notFound。
