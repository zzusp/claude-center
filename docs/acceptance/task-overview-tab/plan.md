# 任务详情页「概览」Tab 内容优化

## 需求
概览 Tab 改为五卡片、三列两行布局，去掉左右内外补白加宽：
- 第一行：**基本信息** / **进度** / **任务描述**（任务描述在最右列、跨两行）
- 第二行：**相关信息** / **执行结果**
- 基本信息：任务 ID、项目、签出/工作/目标分支、提交模式、自动合并 PR（仅 PR 模式）、自动回复、执行模型
- 进度：顶部百分比进度条（已创建/已认领/开始执行/执行结束/提交代码/[PR 模式]已合并落地）+ 各里程碑节点（左名右时间 `YYYY-MM-dd HH:mm:ss`）+ 事件流全量节点；高度与基本信息卡一致，超出滚动
- 任务描述：描述 + 附件 + claude 提问/用户答复（有数据才显示）
- 相关信息：Worker、Session ID、PR（`#编号` 超链接 + 分支 icon）、开始执行时间、完成/失败/取消时间
- 执行结果：成功显示「执行结果摘要」、失败显示「失败时的错误说明」

## 方案
- `apps/console/app/ui/task-detail-overview.tsx` 重写：本地 `OvCard`（卡头 + 卡体，`scroll` 卡用「相对 region + 绝对 body」让卡身高度由外层 grid 拉伸决定、内容超出内部滚动且不反向撑高卡片）。
- 布局：外层 `overview-grid` = `2fr 1fr`（左区 + 任务描述列）；左区 `ov-left` 再 `1fr 1fr` × 两行 → 视觉三等列。任务描述列由 `align-items: stretch` 自动等高于左区两行总高。
- 进度卡随基本信息卡等高：进度卡为 scroll 卡，其绝对 body 不撑高 → 行高由基本信息卡决定。
- 进度里程碑单调推进：取最远抵达节点，其前节点一并 done，百分比 =（最远抵达序号+1）/ 总数。节点时间取 task 字段 + `task_events`。
- claude 提问/用户答复 = `task_comments`（worker=提问、user=答复），`OverviewTab` 内懒轮询 `/api/tasks/[id]/comments`。
- 执行结果摘要取 `task.result.claudeResult`（worker `markTaskSuccess` 落库），失败取 `task.error_message`。
- 加宽：`detail-tab-content--wide` 去掉 `max-width:1180px` 与左右 padding，铺满 `.view` 内容宽度（保留 `.view` 32px 页面统一栏距，与顶部标题/页签对齐）。
- 多仓 PR 表 / 前置任务为少数任务才有的补充信息，移到五卡之下整行展示（按需），不污染五卡固定结构、也不丢功能。

## 改动文件
- `apps/console/app/ui/task-detail-overview.tsx`（重写）
- `apps/console/app/ui/task-detail.tsx`（OverviewTab 传 `events`、去掉 `lifecycle` 入参；概览页签套用 `detail-tab-content--wide`）
- `apps/console/app/globals.css`（新增「概览 Tab：五卡三列两行」样式块 + 窄屏退化）

## 验证
- `npm -w @claude-center/console run typecheck`：通过
- `npm -w @claude-center/console run build`（webpack 生产构建）：通过
- SSR 渲染实跑（`scripts/verify-overview.mjs`）：起 console → admin 登录 → 取真实任务 → 拉 `/tasks/<id>` HTML，断言五卡 + 加宽 class + 进度条均在 SSR 产物内、页面 200。证据见 `round-1.md`。
