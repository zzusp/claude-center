# 实时对话输入框三按钮整改

## 需求

实时对话 `chat-composer` 区域，把「定时」「附件」改成与发送按钮**同款圆形按钮**；三颗按钮（定时、附件、发送）放右下角，从左到右依次排开。

## 现状

- 附件：上方 dashed 区块 + 「添加附件」文本按钮 + 提示文案 + chips 列表，占大量空间。
- 定时：底栏左侧 188px 宽的 `DateTimePicker` trigger（图标 + 文本 + 清除）。
- 发送：底栏右侧 34×34 圆形按钮（`.chat-send`，近黑底白图标）。
- 视觉重心偏左、附件区与文本输入区上下叠，整体不紧凑。

## 方案

1. **统一圆形按钮样式** — 抽出 `.chat-composer-btn` 与 `.chat-send` 共用样式（34×34 圆形、`var(--text-1)` 底色），新增 `.is-active`（蓝色 = 已设置）。
2. **AttachmentUploader `compact` 模式** — 只渲染圆形 Paperclip 按钮，上传中显示 `Loader2` spinner；chips 改由父组件渲染。
3. **DateTimePicker `compact` 模式** — trigger 改成圆形 CalendarClock 按钮，已选时间时 `.is-active`；面板 right-align 上方展开。
4. **chat-thread 输入卡布局** — textarea 上方新增「草稿带」展示定时 chip + 附件 chips；底栏左 hint、右 actions：定时 → 附件 → 发送。

## 改动

- `apps/console/app/ui/attachment-uploader.tsx:13`：新增 `compact`/`onError` props；compact 分支只渲染圆形按钮。导出 `AttachmentChip`。
- `apps/console/app/ui/controls.tsx:381`：新增 `compact` prop；trigger 在 compact 下用圆形按钮 + `CalendarClock` 图标 + `.is-active` 已选态。
- `apps/console/app/ui/chat-thread.tsx:465`：草稿带（定时 chip + 附件 chips）→ textarea → 底栏（hint + 三按钮）；新增 `removeDraftAttachment` 处理草稿删除。
- `apps/console/app/globals.css:4471`：`.chat-send` 与 `.chat-composer-btn` 合并样式 + `.is-active`；新增 `.chat-composer-actions` / `.chat-composer-chips` / `.chat-schedule-chip`；删除旧 `.chat-composer-tools` / `.chat-schedule-picker`，新增 `.dt-picker.compact` 锚定。

## 验证

- `npm run typecheck`：五包通过
- `npm run build`：五包通过（含 console next build）
- `node scripts/ephemeral-db.mjs --verify`：临时库迁移 + verify:console 全绿（`scheduler.ok:true`）
- Playwright 截图：见 [round-1.md](round-1.md)
