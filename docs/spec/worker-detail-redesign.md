# Worker 详情页重构 + 执行机群卡片微调

> 开工前快照（不回头维护）。参考任务详情页（tab 式）重构 worker 详情页，并修执行机群卡片的离线工作态显示。

## 背景与目标

1. **执行机群卡片**：离线 worker 不应显示「工作中/空闲」工作态（离线时该状态无意义、易误读）。
2. **worker 详情页**：现状是单列 Section 长堆叠（基本信息/工作状态/用量/并行任务/关联项目/运行配置/下发命令/危险操作），其中「并行任务」只显示计数、不列任务。参考任务详情页（`task-detail.tsx` 的 tab 布局）重构为 tab 式，并补：
   - **任务 list**：该 worker 名下任务，支持按状态快速筛选，仅列表（不展开详情）、点击跳 `/tasks/{id}`。
   - **对话 list**：该 worker 名下对话，仅列表、点击跳 `/chat?c={id}`。
   - **命令日志**：worker 收到的定向命令 + stdout/stderr/退出码（现有「下发命令」面板的数据）。

## 现状与数据源（均已存在，无需改后端/迁移）

- `GET /api/tasks?workerId=&status=&pageSize=&page=`：按 worker + 状态筛选 + 分页（`apps/console/app/api/tasks/route.ts`）。
- `GET /api/conversations?workerId=`：按 worker 列对话（`apps/console/app/api/conversations/route.ts`，无分页，量小）。
- `GET /api/workers/[id]/direct-commands`：worker 定向命令历史（含 result.stdout/stderr/exitCode、error_message），权限 `command.create`。
- 任务详情页参考：tab 机制在 `task-detail.tsx` + `task-detail-shared.tsx`（`DETAIL_TABS`、`detail-tabs`/`detail-tab-btn`/`detail-tab-content`、`detail-summary-bar`）。

## 方案

### 1. 执行机群卡片（`apps/console/app/ui/workers.tsx`）
`<WorkingStateBadge>` 仅在 `worker.status === "online"` 时渲染（卡片 + 详情页 header 同口径）。

### 2. worker 详情页（`apps/console/app/ui/worker-detail.tsx` 重写）
布局参考任务详情页：
```
detail-page
  detail-page-top (sticky): 返回 + 标题(名字) + StatusBadge(在线状态) + WorkingStateBadge(仅在线)
  detail-summary-bar: 主机 / claude 版本 / 心跳 / 在途 N/M / 完成 N / Worker ID
  detail-tabs: 概览 | 任务 | 对话 | 命令日志(仅 canCommand)
  detail-tab-content:
    overview → 现有 Section：基本信息 / 工作状态 / 套餐用量 / 关联项目 / 运行配置 / 危险操作
    tasks    → WorkerTasksTab：状态 chip 筛选 + 任务表（跳 /tasks/{id}）
    conversations → WorkerConversationsTab：对话表（跳 /chat?c={id}）
    commands → WorkerCommandPanel（现有，下发 + 历史回显）
```
- tab 状态用 `useState<TabKey>`；非 admin 过滤掉 commands tab。
- 「下发命令」从概览移入 commands tab；「并行任务」纯计数 Section 删除（任务 tab 取代）。
- 任务/对话两个 list tab 抽到新文件 `worker-detail-tabs.tsx`，主文件保持可读。

### 3. 任务状态快速筛选
一排 chip 按钮（复用 `.btn .btn-sm`，选中加 `.btn-primary`，零新增 CSS），列全部状态；点击设 `status` 走后端筛选 + 简单分页（pageSize=50）。

### 4. 对话跳转 deep-link（`apps/console/app/ui/chat.tsx`）
`ChatView` 挂载后读 `window.location.search` 的 `c` 参数初始化 `activeId`（现有「筛选结果不含当前会话则清空」逻辑天然兼容，无 SSR/Suspense 改动）。

### CSS
全部复用任务详情页现有类（`detail-tabs`/`detail-tab-btn`/`detail-tab-content`/`detail-summary-bar`/`ds-item`/`table`/`table-wrap`）。如需 list 行/筛选条微调，仅加少量局部类。

## 不做（后续单独任务）
- Worker 进程（Electron 应用）全量运行日志：当前无采集/上报机制，需 worker 端采集 → 上报 → 新 DB 表 → API 全链路，单独立项。

## 验证计划
- `npm run typecheck` + `npm run build` 绿。
- 启动 console（admin），逐项实测：
  - `/workers` 卡片：离线 worker 不显示工作态徽章。
  - `/workers/{id}`：四个 tab 可切换；任务 tab 状态 chip 筛选生效、点击行跳 `/tasks/{id}`；对话 tab 点击跳 `/chat?c={id}` 并自动选中；命令日志 tab 回显历史。
