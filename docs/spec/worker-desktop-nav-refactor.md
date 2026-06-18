# Worker 桌面端导航重构

> 把 Electron Worker 桌面窗（`apps/worker`）从「单页平铺 8 张卡片 + 整页滚动」重构为「侧边栏菜单 + 固定 app shell + 内部滚动」，视觉/信息架构对齐 web 端 Console（`apps/console`）。

## 现状（重构前）

- `apps/worker/src/main.ts` 里 `windowHtml()` 返回一整页 HTML（data URL 加载）。
- 布局：`header.app-head` + `.layout`（两列 grid）。左列：状态与设置 / 能力自检 / 运行终端 / 套餐用量 / 关联项目；右列：任务 / 对话 / 日志。
- 问题：① 所有功能挤在一屏，信息密度高、无层级；② `body` 无高度约束，内容（任务 / 对话 / 日志多了）撑高整页 → 整个 body 滚动，窗口里看不到固定的导航/状态；③ 与 web 端「侧边栏 + 主区」信息架构不一致。
- 窗口 1040×860。

## 目标

1. **参考 web 端拆菜单**：复刻 Console 的「侧边栏导航 + 主内容区（顶栏 + 可滚动 view）」。
2. **固定窗壳，内部滚动**：窗口高度恒定，内部元素高度变化不再改变窗口/整页高度，溢出走内部滚动条（列表/日志卡片内滚）。
3. **窗口调大**：1040×860 → 1320×900（带 minWidth/minHeight）。

## 菜单拆分（侧边栏，对齐 Console）

| 菜单 | 内容 | 滚动模型 |
|------|------|----------|
| 总览 | 4 张统计卡（工作状态 / 在途任务 / 能力就绪 / 实时通道）+ 本机信息(KV) + 能力自检 + 套餐用量 | 页随 view 滚 |
| 任务 | 本机任务面板（分组 + 展开详情 + 回复/取消/续接重试） | 整页填充卡片，`card-body` 内滚 |
| 对话 | 本机承接的实时对话（只读，含流式增量） | 整页填充卡片，`card-body` 内滚 |
| 项目 | 关联项目列表 + 添加表单 | 列表 `max-height` 内滚，表单常驻 |
| 设置 | 状态与设置（工作态/远程开关/并发）+ 运行终端（终端/前置命令） | 页随 view 滚 |
| 日志 | 本机运行日志（仅内存） | 整页填充卡片，日志区内滚 |

顶栏右侧常驻全局指示：SSE 连通性 pill（`#relayDot`/`#relay`）+ 工作态徽标（`#state`）。侧栏底部常驻 worker 身份（名字 + 主机）。任务/对话菜单项带数字角标（待输入任务数 / 在途对话数）。

## 布局与滚动模型（核心）

```
html,body { height:100% }
body { overflow:hidden }           /* 整页不滚 */
.app  { display:flex; height:100vh }
.sidebar { width:200px; height:100vh }            /* 固定 */
.main { flex:1; height:100vh; display:flex; flex-direction:column }
.app-header { flex-shrink:0 }                      /* 固定 */
.view { flex:1; min-height:0; overflow-y:auto }    /* 唯一的页级滚动容器 */
.page.fill { height:100% }                         /* 任务/对话/日志：撑满 view */
.page.fill > .card { flex:1; min-height:0; display:flex; flex-direction:column }
.scroll-body { flex:1; min-height:0; overflow:auto } /* 卡片内滚 */
```

要点：窗口（Electron OS 窗）尺寸固定；`.main` 锁 `100vh`；只有 `.view` 与「整页填充卡片的 `card-body`」是滚动容器。内容变多 → 内部滚动条出现，窗口/整页高度不变。

## 实施

- 抽出 `apps/worker/src/window-html.ts`（`export function windowHtml()`），承载整页 HTML（理由：renderer 字符串体量大、与 Electron 启动职责分离、便于离屏预览截图验证）。`main.ts` 仅留 Electron 启动 + IPC + `createWindow`（import `windowHtml`）。
- 渲染层 JS 保持原约束：不嵌套反引号 / 不用 `${}`（外层模板字面量），沿用字符串拼接。
- 全部既有逻辑（refresh / 任务面板 / 对话面板 / 项目 / 终端 / 轮询定时器）保留；新增：`showPage()` 菜单切换、总览统计卡填充、侧栏角标。
- 窗口尺寸：`width:1320, height:900, minWidth:1080, minHeight:720, backgroundColor:"#f8f8f6"`。

## 验证

- `npm -w @claude-center/worker run typecheck` + `build` 绿。
- 离屏渲染验证（`cd apps/worker && npm run preview:ui`）：`apps/worker/scripts/`（`package.json` main 指向 `preview-main.cjs` + 样例数据 `preview-preload.cjs`）用 Electron offscreen 加载 `windowHtml()`，逐菜单 `capturePage()` 出 PNG 到 `$TEMP/worker-ui-preview/`，肉眼核对。
- 实测结论（6 页全过）：窗口锁定 1320×900（截图均 1982×1352 = ×1.5 DPI，内容增多窗口不变）；任务/对话/日志页整页填充卡片且**卡片内部出现滚动条**；总览统计卡 + 本机信息 + 能力自检 + 套餐用量、设置页开关/终端、项目增删、流式对话气泡均正常渲染。
- Electron 调用坑（本机踩到）：① electron.exe 是 GUI 子系统、stdout 不连终端，诊断须写文件；② `import()` 绝对路径要 `pathToFileURL`；③ 须 `electron <含 package.json 的目录>` 形式 + 等待进程真正退出（`npm run` / `Start-Process -Wait`）。
