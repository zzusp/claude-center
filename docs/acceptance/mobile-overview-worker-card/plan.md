# 手机端「Worker 概览」卡片内容溢出修复

## 症状
总览页（`apps/console/app/ui/overview.tsx`）的「Worker 概览」卡片在手机端（≤390px 视口）显示时，
行内的并发用量条与「2/3 / 0/4 / 5/5」计数文字溢出卡片右缘、贴到屏幕边缘之外。

## 根因
`.worker-row[data-layout="split"]`（`globals.css:1497`）是一行 5 栏等分 grid：
`auto minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr)`
（状态点 | 名字 | claude 版本 | 工作态徽章 | 并发条）。

桌面宽卡片下 4×1fr 够用；但在 grid-2 折叠成单列（≤1000px）后，手机窄屏里每个 1fr 栏只剩约 71px，
而第 5 栏的并发条是**固定 80px**（`.worker-usage-bar`）+ 文字、第 4 栏徽章 `white-space:nowrap` 不可收缩——
固定宽内容塞不进 minmax(0,1fr) 栏，便横向溢出栏 → 撑出卡片与屏幕。

地面真值（390 视口，修复前）：`.worker-usage` 右缘 = 390px，卡片内容区右缘 = 375px，**溢出 +15px**。

## 改动
`apps/console/app/globals.css` 的 `@media (max-width: 560px)` 块内，把该行改为**两行布局**：

```
"dot name  badge"
"dot ver   usage"
```

- 3 栏 `auto minmax(0,1fr) auto`：状态点跨两行竖向居中；名字/版本可省略号收缩；徽章与并发条放第 3 栏（auto 自适应其内容宽）。
- 子项用 `:nth-child(1..5)` 按 JSX 固定顺序映射到 grid-area，无需改动 `overview.tsx`。
- 仅 ≤560px（手机档）生效；560–1000px 平板单列卡片仍够宽，保持原 4 栏。
- 基础规则（`globals.css:1497`）在本 @media 之前，同特异性下后者胜，直接覆盖（参考 memory: console-mobile-css-cascade-order）。

## 验证
纯 CSS 改动，用 headless Chrome（CDP 强制 390 真视口）内联真实 `globals.css` + 复刻卡片 DOM 截图，
打 `getBoundingClientRect` 地面真值。脚本 `scripts/shot.mjs`，证据 `round-1/{before,after}.png`。

修复后：`.worker-usage` 右缘 = 357px < 卡片内容区右缘 375px，**内缩 −18px，无溢出**。
