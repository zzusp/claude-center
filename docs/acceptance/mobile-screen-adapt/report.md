# 验收报告：手机端不同屏幕尺寸适配

状态：**全绿**（matrix.csv round-1 全 PASS）。

## 结论

两条诉求均落地并经地面真值验证（CDP 真实视口截图 + getBoundingClientRect 度量，见 `round-1.md`）：

1. **任务详情四 Tab 卡片边距**：根因是长 Tab「Claude Code 执行」的 Tab 条不换行/不滚动，把布局视口
   撑宽到 418px，使卡片右边距随屏宽变化（72/42/19px）。改为 Tab 条手机端**条内横向自滚**后，卡片
   左右边距在 360/390/414 各屏宽下**恒为 14px**、零横向溢出。

2. **实时对话布局**：`session-meta-bar` 手机端**默认折叠**（头部 `ⓘ` 可逆展开），标题子信息**单行省略**，
   消息区**隐藏滚动条**（保留触摸滚动）。消息区高度由 296px 增至 471px（+59%），头部不再排列混乱。

## 改动
- `apps/console/app/globals.css`
- `apps/console/app/ui/chat-thread.tsx`
- `apps/console/app/ui/session-meta.tsx`

## 证据
- `before/` `after/` 截图（360/390/414）+ `before/probe.json` `after/probe.json` 度量。
- 再生成：`node docs/acceptance/mobile-screen-adapt/scripts/shot.mjs <before orig|after new>`。

## 已知/未涉及
- 任务详情「执行记录」Tab 也用 `SessionMetaBar`，未传 `open` → 默认常驻（`data-open="1"`），本期不折叠（仅
  实时对话页诉求）。
- `.chat-wrap` 高度 `calc(100dvh - 132px)` 下方留白为既有行为，非本次诉求，未改动。
