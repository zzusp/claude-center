# Round 1 — 实时对话输入框三按钮

## 环境

- console dev server: `http://127.0.0.1:3010`（Turbopack）
- worker `company-pc` online，会话 `小小鹏` 用作示例
- 截图脚本：`scripts/shot.mjs`（Playwright headless chromium，DPR=2）

## 命令输出

```text
> npm run typecheck    →  五包全部 OK（db / relay-client / console / worker / relay）
> npm run build        →  五包全部产物生成；/chat 路由 7.28 kB / 169 kB First Load
> node scripts/ephemeral-db.mjs --verify
  ✓ verify:console 通过   （scheduler.ok:true / mergeCheck.ok:true）
  ✓ dropped database claude_center_ephemeral_1782490268843
```

## 截图（`round-1/`）

桌面端 1440×900：

- `chat-thread.png` — 进入会话，composer 右下角三个圆形按钮（定时 / 附件 / 发送）依次排开
- `chat-thread-typed.png` — 输入文本后 composer focus 蓝边、按钮启用态
- `chat-thread-schedule-open.png` — 点定时按钮，日期面板向上 + 右对齐展开
- `chat-thread-scheduled.png` — 选定时间后草稿带显示 `2026-07-11 00:05` chip + 定时按钮蓝色 is-active

手机端 390×844：

- `mobile-chat-thread.png` — 三按钮在窄屏同样依次排开
- `mobile-chat-thread-typed.png` — 文本输入态
- `mobile-chat-thread-schedule-open.png` — 日期面板向上展开（贴近输入框底部）
- `mobile-chat-thread-scheduled.png` — 草稿带显示定时 chip + 按钮蓝色 is-active

## 结论

- 三按钮（定时 / 附件 / 发送）尺寸/形状一致，均为 34×34 圆底白图标，从左到右排开，紧贴发送按钮。
- 定时已设置态用 `var(--running)`（蓝色）填充按钮 + 上方草稿带 chip 双向指示。
- 桌面 / 手机两套视口均验证通过。
