# 验收报告 — 手机端 Worker 概览卡片溢出修复

状态：**全绿**（matrix.csv 3/3 PASS，round-1）

## 结论
总览页「Worker 概览」卡片在手机端（390px）的行内并发条 + 计数文字溢出卡片/屏幕的问题已修复。
改动为纯 CSS（`apps/console/app/globals.css` 的 `@media (max-width: 560px)`），窄屏改两行布局。

## 地面真值（CDP 强制 390 真视口，内联真实 globals.css）
| | 卡片内容区右缘 | `.worker-usage` 右缘 | 相对卡片 |
|---|---|---|---|
| before | 375px | 390px | **溢出 +15px**（贴到屏幕边缘外） |
| after  | 375px | 357px | **内缩 −18px**（落在卡片内） |

三行 worker 测量值一致。截图见 `round-1/before.png`（计数贴屏幕边缘）与 `round-1/after.png`（两行整齐落在卡内）。

## 复现
```powershell
node docs/acceptance/mobile-overview-worker-card/scripts/shot.mjs apps/console/app/globals.css 9341
```
脚本同时输出 before（用 `!important` 还原修复前 5 栏等分）与 after（真实 css）两张图 + 控制台地面真值。
