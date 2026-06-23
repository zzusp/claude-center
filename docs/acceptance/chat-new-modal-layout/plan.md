# 实时对话「新建对话」弹窗加宽 + 双列表单

## 需求
实时对话页（`apps/console/app/ui/chat.tsx` → `NewConversationPanel`）的「新建对话」弹窗宽度太窄（420px），
8 个表单项全堆一列、留白难看。需求：
- 加宽弹窗。
- 适当排版，部分表单项排两列。
- 兼顾手机端效果。
- 截图验证。

## 方案
弹窗本体复用既有 `.chat-modal` 结构，仅给「新建对话」加一个作用域修饰类 `chat-modal-wide`
（对话设置弹窗 `ConversationSettingsModal` 仍用窄默认，不受影响）：
- `.chat-modal-wide` 宽度 420 → **560**。
- `.chat-modal-wide .chat-modal-body` 由 flex 单列改 `grid` 2 列；`.chat-field` 默认 `grid-column: 1 / -1`（整行），
  新增 `.chat-field-half` 占一列。
- **短字段两两并排**：项目 + 分支、Worker + 模型；长字段（标题 / 自动回复 / 决策预案 / 首条消息 / 定时发送）整行铺满。
- **窄屏回落**：`@media (max-width: 560px)` 把 body 收回单列、`.chat-field-half` 复位整行。
  该 media query **置于基础网格规则之后**——等特异性下后者胜，避开本仓「@media 在前被靠后基础规则反盖」的级联坑。

## 改动
- `apps/console/app/ui/chat-thread.tsx`：`NewConversationPanel` 根 modal 加 `chat-modal-wide`；
  项目 / 分支 / Worker / 模型 四个 `.chat-field` 加 `chat-field-half`。
- `apps/console/app/globals.css`：`.chat-field` 块后新增 `.chat-modal-wide*` 规则 + 窄屏回落 media query。

## 验证
- `npm run typecheck` 五包绿。
- 纯 CSS 布局截图（`scripts/shot.mjs`，内联真实 globals.css + 复刻 DOM，CDP 强制真实视口）：
  桌面 1024 + 手机 360/390/414 四档，见 `round-1.md` / `matrix.csv` / `after/`。
