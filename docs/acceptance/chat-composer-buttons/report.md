# Report — 实时对话输入框三按钮整改

matrix 全绿（round-2 全部 PASS）。详情见 [matrix.csv](matrix.csv) + [round-1.md](round-1.md) + [round-2.md](round-2.md)。

## 关键证据

- typecheck / build 五包通过
- ephemeral-db verify:console 输出 `scheduler.ok:true`（round-1）
- 桌面 + 手机端两轮共 20 张截图覆盖：默认态 / 输入态 / 定时面板 / 已定时态
- round-2 修复：① 移动端日期面板底部抽屉化彻底解决左溢出；② 主次按钮视觉分级（送 = 实心黑，定 / 附 = 透明灰）

## 改动文件

- `apps/console/app/ui/attachment-uploader.tsx`：compact 模式 + 导出 AttachmentChip + onError
- `apps/console/app/ui/controls.tsx`：DateTimePicker compact 模式
- `apps/console/app/ui/chat-thread.tsx`：composer 布局重排（草稿带 + 右下三按钮）；发送按钮恢复 `.chat-send` 主操作样式
- `apps/console/app/globals.css`：拆分 `.chat-send` 主操作 / `.chat-composer-btn` 次操作；移动端 `.dt-picker.compact .dt-panel` 改 fixed bottom-sheet
