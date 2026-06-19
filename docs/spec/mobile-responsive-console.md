# 手机端适配（响应式单套代码）

## 需求

让 Web Console（`apps/console`）可在手机端使用，主场景是「清办公」：
浏览/处理任务列表、看任务进度、发布与编辑表单、实时对话与回复。
用户明确：**列表页右侧统计卡片在手机端可省略**，优先保证主流程
（表单 / 列表 / 进度查看 / 对话 / 回复）。

## 方案

在现有单套代码上做响应式适配（不另开手机端页面），复用全部业务逻辑/数据通道。
统一新增**手机断点 `@media (max-width: 820px)`** 承载移动端行为，
辅以既有 `560px` 细化断点。原有 900/1000/1100/1200 中等屏断点保持不变。

### 改动点

1. **导航：侧滑抽屉**（`shell.tsx` + css）
   - `.app-header` 左侧加汉堡按钮（`.nav-toggle`，仅 ≤820 显示）。
   - 桌面 `.sidebar`（固定 220px）在 ≤820 变为左侧滑出抽屉：`position:fixed` +
     `translateX(-100%)`，`.sidebar.open` 滑入；配 `.sidebar-backdrop` 遮罩点击关闭。
   - 抽屉内复用既有 brand + nav 标记，加 `.nav-close`（X）。
   - 选中导航项 / 路由变化 / 点遮罩 自动关闭。
   - 替换原 ≤820 把 sidebar 压成横向图标条的旧规则。

2. **列表页右侧统计省略**：`.page-grid-aside { display:none }`（tasks/users/projects 三页共用 `.page-grid`，一处生效）。

3. **任务列表 → 卡片**（`tasks.tsx` 主表加 `table-cards` 类 + 每 `<td>` 加 `data-label`）
   - ≤820 时 `thead` 隐藏，`tr` 变卡片，`td` 变「标签—值」行，`::before` 取 `data-label`。
   - 标题 `<td>`（`.mb-title`）整行强调、可换行、不截断；操作列右对齐。
   - 勾选列（`.td-select`）手机端隐藏（单条操作按钮已满足清办公；批量为桌面能力）。
   - 解除 `.table-wrap.scroll-rows-10` 的高度限制，改页面自然滚动。
   - 其余表格（users/projects/worker 详情）保持 `.table-wrap` 横向滚动兜底（不溢出、能用）。

4. **实时对话 → 主从切换**（`chat.tsx` + `chat-thread.tsx`）
   - `.chat-wrap` ≤820 单列、`data-active` 控制：未选会话显示列表、选中显示消息线。
   - `ChatThread` 新增可选 `onBack`，头部渲染移动端返回按钮（`.chat-back`）。

5. **进度查看 / 详情页**：`.detail-page-body`、`.view`、`.app-header` 移动端收紧内边距；
   `.detail-grid` 已在 900 堆叠，沿用。

6. **杂项**：`.worker-grid` 卡片最小宽度移动端下调；`.notif-panel` 宽度 `min(360px, 100vw-24px)`
   防溢出；`.app-header-sub` / 用户名文字移动端隐藏省横向空间。

## 验证

`npm run typecheck` + `npm run build`（console 走 webpack 全量构建）；
`npm run verify:console` 看 `401→200` + `scheduler.ok:true`；
浏览器 devtools 移动视口（iPhone 390px）人工过一遍主流程。
