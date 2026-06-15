# 任务列表 / 任务详情 重构（按 task-list-and-detail.png/.html）

## 目标

按设计稿 `docs/spec/task-list-and-detail.png` 和结构说明 `docs/spec/task-list-and-detail.html`，重构 `apps/console`：

- 任务列表页：左主区表格 + 右侧三块卡片（任务概览 / 状态分布 / 今日统计）
- 任务详情页：顶栏 actions + summary bar + Tabs（概览 / 时间线 / 对话 / Claude Code 执行 / 日志）

## 与现有数据的差异 & 取舍

| 设计原型字段/区块 | 现状 | 取舍 |
|---|---|---|
| 列表「文件」列 | tasks 表无 per-task 文件 | **去掉**；不新增数据模型 |
| 列表「Worker」列 | 只有 `claimed_by`（uuid） | listTasks/listRecentTasks JOIN `workers` 暴露 `worker_name` |
| 列表「PR」列 | 已有 `pr_url` | 从 URL 末段提取 `#数字` 展示，无 PR 时 `—` |
| 列表「时间」列 | 现已显示 `updated_at` | 保持；表头沿用「更新」（点击切排序方向） |
| 右栏「任务概览」 | `/api/dashboard.summary` 已有计数 | 新增 `/api/tasks/stats` 统一统计端点 |
| 右栏「状态分布」 | 无独立接口 | `/api/tasks/stats` 顺带返回各状态计数；UI 用纯 CSS 横条 |
| 右栏「今日统计」 | 无 | `/api/tasks/stats` 按日窗（本地 00:00）算完成率（accepted+merged）/(终态总数) + 平均耗时 |
| 详情页 Tabs | 现为纵向铺开 | 改 Tabs；初始默认「概览」 |
| 详情页 Summary bar | 散落在 hero/aside | 顶栏标题下新增 summary-bar：Task ID / 项目 / 分支 / Worker / 创建时间 |
| 「重试」按钮 | 现有「重新激活」 | 文案改「重试」，行为同前；只在 failed/cancelled 显示 |
| 「编辑/删除」 | 现各种 hero-actions 行 | 移到顶栏 actions 区；编辑走 Drawer，删除走 useConfirm |
| 「验收」 | 已有 TaskReviewActions | 保留在「概览」Tab 顶部高亮区 |

## 改动清单

### 1. DB 层（`packages/db/src/queries.ts` + `types.ts`）

- `Task` 类型加 `worker_name?: string`
- `listTasks` / `listRecentTasks` / `getTaskWithDeps` / `listRecentTasksForUser`：`LEFT JOIN workers ON workers.id = tasks.claimed_by` 取 `workers.name AS worker_name`
- 新增 `TaskStatsResult` 类型 + `listTaskStatsForUser` 函数：
  - 全集 totals + byStatus
  - today 范围（本地午夜，由调用方传 cutoff）：finished/accepted 数 + 平均耗时
- 非 admin 在 SQL 内 JOIN `user_project_links` 限制范围

### 2. API（`apps/console/app/api/tasks/stats/route.ts`）

新增 GET 路由，调 `listTaskStatsForUser` 返回 JSON。

### 3. 列表页（`apps/console/app/ui/tasks.tsx`）

- 表格列：任务 / 项目 / 分支 / 状态 / 合并 / Worker / PR / 更新 / 操作
- 容器外层布局：`<div class="page-grid"><main /><aside /></div>` 双栏
- 右侧 `<TasksSidebar />` 内部轮询 `/api/tasks/stats`，三卡

### 4. 详情页（`apps/console/app/ui/task-detail.tsx`）

- 顶栏 actions 区按 status 渲染 [发布][编辑][重试][取消][删除]
- summary-bar：Task ID / 项目 / 分支 / Worker / 创建时间
- Tabs：概览 / 时间线 / 对话 / Claude Code 执行 / 日志
- 概览 Tab 含：阻塞提示、验收行（success 时）、描述、错误、信息 KvRow、前置任务
- 编辑走 Drawer；删除走 useConfirm

### 5. CSS（`apps/console/app/globals.css`）

新增：`.page-grid` `.sidebar-card` `.sb-bar-row` `.detail-summary-bar` `.detail-actions` `.detail-tabs` `.detail-tab-btn` `.detail-tab-content`。

## 验收

- `npm run typecheck` 全绿
- `npm run build` 全绿
- `npm run verify:console` 401→200 通过
- 浏览器手测：右侧三卡显示、Worker 名展示、Tabs 切换、actions 动态显示
