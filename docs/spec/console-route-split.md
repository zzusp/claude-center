# Console 菜单页路由化 + API 拆分

> 把 Web Console 从「单页 `?view=` 客户端切换 + 单个胖 `/api/overview`」重构成「每个菜单一个独立路由 segment + 各页独立 API」。route group 共享侧边栏/topbar 外壳。

## 目标

- 6 个主菜单各成独立路由：`/`(总览)、`/tasks`、`/chat`、`/workers`、`/projects`、`/users`。URL 即页面，刷新/分享/前进后退原生可用。
- 删除胖 `/api/overview`，按页拆成各自轻量端点；每页只取自己要的数据。
- 侧边栏徽标计数 + topbar 心跳由外壳层独立轻量轮询维持，跨页保持新鲜。
- 行为不回退：各页展示/权限/mutation 刷新与现状一致；`build` 绿 + `verify:console` 见 `401→200`。

## 现状（重构前）

- `app/page.tsx`(server 鉴权)→ `app/ui/dashboard.tsx` 一个大 client 组件，持有 `overview` 状态 + 单条 `usePolling` 轮询 `/api/overview`，用 `view` 状态 + `history.replaceState` 切 6 个视图（`dashboard.tsx:67-80,248-284`）。
- `/api/overview`(`api/overview/route.ts`)一次性返回 `projects/workers/tasks/commands/summary/health`，被 6 个视图共享。
- 详情页 `app/tasks/[id]`、`app/workers/[id]` **已是独立路由**（server 端各自取数，无侧边栏），本次不动。
- 各视图对 overview 的真实依赖（Grep 实测）：
  | 视图 | 真正用到的 overview 字段 | 自己已轮询的端点 |
  |---|---|---|
  | DashboardView | summary, workers, tasks, health | — |
  | TasksView | projects（筛选/表单）、tasks（依赖候选） | `/api/tasks`(分页) |
  | ChatView | projects、workers（在线） | `/api/conversations` |
  | WorkersView | workers、summary.onlineWorkers（tasks 是死 fallback） | — |
  | ProjectsView | projects | — |
  | UsersView | projects（名映射/表单） | `/api/users` |
- `overview.commands`、`history`(sparkline)只服务总览；`commands` 前端实际无人消费（丢弃）。
- 外部对 `?view=` 的引用：`worker-detail.tsx:148,214` 的 `router.push("/?view=workers")`。

## 方案

### 路由结构（route group `(app)`）

```
app/
├── layout.tsx                 # root(html/body) 不变
├── login/                     # 不变
├── (app)/                     # NEW route group（不影响 URL）
│   ├── layout.tsx             # server: 鉴权→<Shell currentUser>{children}</Shell>
│   ├── page.tsx               # /        总览
│   ├── tasks/page.tsx         # /tasks
│   ├── chat/page.tsx          # /chat
│   ├── workers/page.tsx       # /workers
│   ├── projects/page.tsx      # /projects
│   └── users/page.tsx         # /users   server 端权限门(无 user.manage → notFound)
├── tasks/[id]/page.tsx        # 不变(详情，group 外，无侧边栏)
└── workers/[id]/page.tsx      # 不变
```

- `app/ui/shell.tsx`(NEW, client)：侧边栏 + topbar，自己轮询 `/api/summary` 拿徽标计数 + 心跳；用 `usePathname` 决定 active 项与 topbar 标题（取代 `view` 状态 + pageMeta 查表）。children 渲染进 `<div className="view">`。
- **不需要 React Context**：Shell 自包含徽标/心跳；各 page 自包含数据；创建后侧边栏计数靠 summary 轮询（≤3s）自动追平，与现状轮询驱动一致。
- `app/page.tsx`、`app/ui/dashboard.tsx`、`app/api/overview` 删除。

### 端点设计

| 端点 | 动作 | 返回 | 服务谁 |
|---|---|---|---|
| `/api/summary` | **新** GET | `{ counts: { tasks, workers, projects } }` | Shell 徽标（synced/lastSyncAt 客户端按请求成败派生） |
| `/api/dashboard` | **新** GET | `{ summary, workers, tasks, health }` | 总览页（= 原 overview 去 projects/commands） |
| `/api/workers` | **新** GET | `{ workers }` | 机群页、对话页（在线 worker） |
| `/api/projects` | **加** GET | `{ projects }`（`listProjectsForUser`） | 任务/对话/用户/项目页 |
| `/api/overview` | **删** | — | — |
| `/api/tasks` `/api/users` `/api/conversations` | 不变 | | 各自页 |

计数口径沿用 overview：tasks=`listRecentTasksForUser(user,80)` 同源计数 / workers=`listWorkers` 数 / projects=`listProjectsForUser` 数。summary/health 计算逻辑从 overview 原样搬到 `/api/dashboard`。

### 各页数据流（容器组件，client）

| 页 | 轮询/取数 | 备注 |
|---|---|---|
| `/` 总览 | `/api/dashboard`(轮询) | history 本地累积、statusCounts 本地派生（逻辑从 dashboard.tsx 搬入） |
| `/tasks` | `/api/tasks`(分页，TasksView 自轮询不变) + `/api/projects` + `/api/tasks?pageSize=100`(依赖候选) | TaskDrawer 创建逻辑(`handleTaskSubmit`)从 dashboard 搬入本页容器 |
| `/chat` | `/api/conversations`(ChatView 自轮询不变) + `/api/projects` + `/api/workers` | |
| `/workers` | `/api/workers`(轮询) | 不再依赖 tasks |
| `/projects` | `/api/projects`(轮询) | onChanged=重新 fetch |
| `/users` | `/api/users`(UsersView 自轮询不变) + `/api/projects` | server 端先挡 user.manage |

### 组件改造（props 去 overview 化）

- DashboardView：`overview`→ 容器传 dashboard payload（`summary/workers/tasks/health` 同字段名），history/statusCounts/onOpenTask 不变。
- WorkersView：`overview`→ `workers: Worker[]`（onlineWorkers 内部算）。删未用的 `canCommand/onChanged`。
- ProjectsView：`overview`→ `projects: Project[]`，`onChanged/canManageProjects` 不变。
- UsersView：`overview`→ `projects: Project[]`，`currentUser` 不变。
- ChatView：`overview`→ `projects: Project[]` + `workers: Worker[]`，`canCommand` 不变。
- TasksView：`overview`→ `projects + dependencyCandidates`（候选下传 ComposeTaskForm/编辑表单），其余不变。
- `dashboard-shared.ts`：保留 `Overview`/`Health` 类型（总览复用）；`ViewKey`/pageMeta 迁入 Shell 改为 pathname 驱动。
- `worker-detail.tsx`：`/?view=workers`→ `/workers`。

## 迁移步骤

1. 端点：加 `/api/projects` GET、建 `/api/workers`、`/api/summary`、`/api/dashboard`。
2. 建 `(app)/layout.tsx` + `shell.tsx`；先搭骨架 `build` 验证 route group 与 `/tasks/[id]` **不路由冲突**（最大技术风险，提前证伪）。
3. 逐页迁移：每页建 `(app)/<seg>/page.tsx` + client 容器，改对应 view 组件 props，`npm run typecheck` 过一页推进一页。
4. 删 `app/page.tsx`、`dashboard.tsx`、`/api/overview`；改 `worker-detail` 跳转。
5. 全量 `typecheck` + `build` + `verify:console`。

## 验证

- `npm run typecheck`、`npm run build` 五包绿。
- `npm run verify:console` 见 `401→登录→200`（改了服务端入口/路由，build 绿是假信号，必须实跑）。
- 手验各路由：直接 GET `/tasks` `/workers` 等可达；`/users` 无权限被服务端挡；侧边栏徽标随轮询刷新；详情页 `router.back()` 回列表正常。

## 风险

- **route group 与 `app/tasks/[id]` 路径共存**：`(app)/tasks/page.tsx`(/tasks) 与 `tasks/[id]/page.tsx`(/tasks/[id]) URL 不同、应不冲突；步骤 2 提前 `build` 证伪，冲突则把详情页纳入 group 或调整。
- **双轮询**：任一页 = Shell summary 轮询 + 本页轮询，比现状多一条。均为轻量查询，可接受；如压力大再把 summary 节流。
- **Next.js 坑**：勿把 `pg`/`node:` 引入 `instrumentation.ts`/edge（见 CLAUDE.md）；本次只在 route handler / server page 引 db，不碰 instrumentation。
