# 手机端顶部 header 优化

## 需求

手机端（≤820px）顶栏两处优化：

1. header 的 title 靠左、挨着汉堡按钮排放（原先标题被挤到中间）。
2. 消息通知下拉框适配手机端宽度——原先部分内容显示到屏幕之外。

## 根因

两处问题同一类根因：**基础规则在 `@media (max-width: 820px)` 块之后、同特异性反盖移动端覆盖**。

- **标题居中**：`.app-header` 用 `justify-content: space-between`，三个 flex 子项（汉堡 / 标题 / 操作区）间被均分空隙，标题被推离汉堡。
- **下拉溢出**：`.notif-panel` 桌面是 `position: absolute; right: 0`，相对铃铛 `.notif` 定位；但铃铛右侧还有用户头像，铃铛不在屏幕右缘，360px 宽面板的左缘被顶到屏外（实测 390px 视口下 `panelLeft = -97px`，左侧 97px 内容不可见）。
  - 原移动端 `.notif-panel { width: min(360px, calc(100vw-24px)) }`（line ~2911）本想收宽，但基础 `.notif-panel { width: 360px; right: 0 }`（line ~5515）在其**之后**、同特异性 `(0,1,0)`，按源码顺序反盖 → 收宽规则从未生效。

## 方案（仅改 `apps/console/app/globals.css` 的 `@media (max-width: 820px)` 块）

1. `.app-header-actions { margin-left: auto }`——auto margin 吃掉 space-between 的中间空隙，操作区推到最右，标题与汉堡贴左相邻。（基础 `.app-header-actions` 在 line 402 < 移动块，正常被覆盖，无需提特异性。）
2. `.notif .notif-panel { position: fixed; top: 60px; left: 12px; right: 12px; width: auto; max-width: none; max-height: calc(100dvh-76px) }`——改 fixed 贴视口、左右各留 12px、宽度自适应，不再相对铃铛定位。**用 `.notif .notif-panel`（0,2,0）提高特异性**，稳定盖过源码靠后的基础 `.notif-panel`（0,1,0）。

## 验证

纯 CSS 布局改动，验证手段 = 真机视口截图（见 `scripts/shot.mjs`）+ Next 构建。详见 `matrix.csv` / `report.md`。

## 范围外（已发现、未改、待用户定夺）

`.user-meta { display: none }`（移动块 line ~2904）同样被基础 `.user-meta { display: flex }`（line ~3312，源码靠后）反盖——手机端用户名/角色文字仍显示（截图右上「管理员 / 超级管理员」）。与本任务两条目标无冲突，且属未点名的相邻元素，按「不顺手改旁边代码」未动；如需隐藏，同法 `.user-chip .user-meta { display: none }` 提特异性即可。
