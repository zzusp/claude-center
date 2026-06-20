# 验收报告 — 手机端顶部 header 优化

状态：**全绿**（matrix.csv 全 PASS）。改动仅 `apps/console/app/globals.css` 的 `@media (max-width: 820px)` 块。

## 证据（390px iPhone 级视口，真实 globals.css）

| | 改前 before.png | 改后 after.png |
|---|---|---|
| 标题位置 | 「任务调度」浮在中间，远离汉堡按钮 | 「任务调度」紧贴汉堡按钮、靠左排放 |
| 通知下拉 | 面板左缘越出屏外，左侧图标/正文被裁切 | 面板贴视口左右各留 12px，全部内容可见、正文正常换行 |

CDP 探针地面真值（`scripts/shot.mjs` 用 `Emulation.setDeviceMetricsOverride` 强制 390 视口后 `getBoundingClientRect`）：

- 改前：`innerWidth=390, panelLeft=-97, panelRight=263, panelWidth=360` → 左侧 97px 越界。
- 改后：`innerWidth=390, panelLeft=12, panelRight=378, panelWidth=366` → 完整落在 0..390 内。

构建：`npm -w @claude-center/console run build` 通过（CSS 在 next/webpack 管线编译无误，路由表完整输出）。

## 复现配方

> 截图为纯 CSS 布局验证，不依赖 DB / 登录 / dev server。需本机 Chrome（`C:\Program Files\Google\Chrome\Application\chrome.exe`）；Node 22 自带全局 WebSocket 驱动 CDP。

```powershell
# 改后
node docs/acceptance/mobile-header-dropdown/scripts/shot.mjs apps/console/app/globals.css after.png
# 改前（先取 HEAD 版 css）
git show HEAD:apps/console/app/globals.css > docs/acceptance/mobile-header-dropdown/round-1/before.css
node docs/acceptance/mobile-header-dropdown/scripts/shot.mjs docs/acceptance/mobile-header-dropdown/round-1/before.css before.png
```

## 踩坑记录

`--headless --window-size=390,844` 在 Windows 被 OS 最小窗口宽钳到 ~478px（`innerWidth=478`），截图按错误视口裁切，一度误判面板「右侧溢出」。改用 CDP `Emulation.setDeviceMetricsOverride` 强制 390 视口才与真机一致——`shot.mjs` 已落此法，注释在案。
