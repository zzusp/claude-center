# Round 2 — 视觉层级 + 移动端面板修复

## 用户反馈

1. 移动端选时间，日期控件左侧没显示全（被视口裁切）
2. 定时 / 附件两个按钮的背景色去掉、hover 弱化，让发送按钮视觉优先级更明显

## 改动

- `apps/console/app/globals.css` —
  - 拆分 `.chat-send`（实心近黑 = 主操作）与 `.chat-composer-btn`（透明 + 灰图标 + hover `var(--surface-2)` = 次操作）；`is-active` 用半透明蓝（`color-mix`），强化「已设定时」但不抢发送按钮风头
  - `@media (max-width: 820px)` 内：`.dt-picker.compact .dt-panel` 改 `position: fixed; left/right/bottom: 12px`，作为底部抽屉式面板，避免按钮锚定时面板向左溢出视口
- `apps/console/app/ui/chat-thread.tsx` — 发送 / 终止按钮 className 从 `.chat-composer-btn` 改回 `.chat-send`，恢复主操作视觉强度

## 验证

- `npm -w @claude-center/console run typecheck`：通过
- `npm -w @claude-center/console run build`：通过（`/chat` 仍 7.28 kB / 169 kB）
- 截图（`round-2/`）：
  - `chat-thread-typed.png` — 桌面：发送按钮深色实心，定时 / 附件透明；视觉重心明确落在发送按钮
  - `chat-thread-scheduled.png` — 桌面已定时：定时按钮淡蓝（is-active 半透）+ chip，发送按钮仍是主视觉
  - `mobile-chat-thread-schedule-open.png` — 移动端：日期面板以底部抽屉形式占满视口，7 个星期列完整展示，无任何裁切
  - `mobile-chat-thread-scheduled.png` — 移动端已定时：草稿带 chip + 定时按钮淡蓝
