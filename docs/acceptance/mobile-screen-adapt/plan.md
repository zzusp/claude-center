# 手机端不同屏幕尺寸适配（任务详情卡片边距 + 实时对话布局）

## 需求

1. **任务详情四个 Tab 卡片边距**：不同手机屏幕尺寸下，卡片左右距屏幕的边距会变化，需统一/适配。
2. **实时对话页面**：手机端 title 与 session-meta-bar 排列混乱；title + meta-bar + 内容区 + 输入框
   四块挤在一起导致内容区只剩一小条，体验差。需折叠部分信息、最大化内容区；并考虑隐藏内容区滚动条。

## 根因（地面真值，见 `before/probe.json`）

- **任务详情**：`.detail-tabs`（flex、不换行、无溢出处理）里有长 Tab「Claude Code 执行」，其内在宽度
  达 404px > 手机视口宽。它撑宽了整页**布局视口**：实测 `window.innerWidth` 被撑到 **418px**（与设备
  360/390/414 无关），导致卡片**右边距随屏宽变化 = 72 / 42 / 19px**，左边距恒 14px —— 左右不一致、
  且随屏宽漂移，正是「边距会变化」。
- **实时对话**：`.session-meta-bar` 手机端换行成约 4 行、高度 **128px**；叠加标题子信息换行，把
  `.chat-msgs` 挤到只剩 **296px**（@360）。

## 方案（纯响应式，单套代码；改动集中在 `@media (max-width:820px)`）

### 任务详情（CSS only，`globals.css`）
- `.detail-tabs` 手机端 `overflow-x:auto + flex-wrap:nowrap + 隐藏滚动条`，`.detail-tab-btn` `flex-shrink:0`、
  收紧左右内补白：Tab 条**条内自滚**，不再撑宽布局视口 → 卡片左右边距在各屏宽恒为 `.view` 的 **14px**。
- `.detail-summary-bar .ds-v { max-width:56vw }`：长分支名不再撑破视口（修 Tab 后的潜在新溢出源）。

### 实时对话（`globals.css` + `chat-thread.tsx` + `session-meta.tsx`）
- **会话信息条折叠**：`SessionMetaBar` 新增可选 `open` prop → 渲染 `data-open`；`ChatThread` 加 `metaOpen`
  状态（默认 `false`）+ 头部 `ⓘ`（`.chat-meta-toggle`，仅手机端显示）切换。手机端 `data-open="0"` 时
  CSS 收起本条（属性选择器 (0,2,0) 稳过其后定义的基础 `.session-meta-bar` (0,1,0)）。桌面端忽略、始终展示。
- **标题子信息单行省略**：`.chat-thread-sub` 手机端 `nowrap + ellipsis`，不再换行挤乱头部。
- **内容区**：`.chat-msgs` 手机端隐藏滚动条（`scrollbar-width:none` + webkit），保留触摸滚动（钉住输入框的
  聊天交互不变，仅去掉视觉滚动条——回应「去掉滚动条」诉求）；折叠 meta 后高度由 296px 增至 **471px**。
- `.chat-composer` 手机端收紧外边距，给消息区更多纵向空间。

## 改动文件
- `apps/console/app/globals.css`：基础隐藏组加 `.chat-meta-toggle`；`@media (max-width:820px)` 内新增
  Tab 自滚 / summary 值上限 / 标题子信息省略 / meta 折叠 / 消息区隐滚动条 / composer 收边距。
- `apps/console/app/ui/session-meta.tsx`：`SessionMetaProps` 加 `open?: boolean`，渲染 `data-open`。
- `apps/console/app/ui/chat-thread.tsx`：`Info` 图标 + `metaOpen` 状态 + `.chat-meta-toggle` 按钮 + 传 `open`。

## 验证
- 纯 CSS/DOM 布局走 CDP 真实视口截图（不依赖 DB/登录/dev server，见 `scripts/shot.mjs`）：
  `node docs/acceptance/mobile-screen-adapt/scripts/shot.mjs before orig` / `... after new`，
  360/390/414 三屏宽出 `probe.json` + 截图。
- `npm run typecheck`（5 包）+ `npm -w @claude-center/console run build`（webpack 全量）。
- 证据见 `round-1.md` / `matrix.csv` / `before|after/`。
