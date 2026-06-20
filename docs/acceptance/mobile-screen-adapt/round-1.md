# round-1 验证记录

环境：worktree 全新检出，`npm install --prefer-offline` 装依赖。截图走 CDP `Emulation.setDeviceMetricsOverride`
真实视口（360/390/414 × 844，dpr=2），不依赖 DB/登录/dev server。复刻 `task-detail.tsx` / `chat-thread.tsx` /
`session-meta.tsx` 真实 DOM + 内联真实 `globals.css`。

复现：
```
node docs/acceptance/mobile-screen-adapt/scripts/shot.mjs before orig 9341   # 改造前（原 CSS + 原 DOM）
node docs/acceptance/mobile-screen-adapt/scripts/shot.mjs after  new  9342   # 改造后（新 CSS + 新 DOM）
```

## T1 / T2 任务详情卡片边距（before/probe.json vs after/probe.json）

| 屏宽 | 指标 | before | after |
|---|---|---|---|
| 360 | innerWidth / 卡片左边距 / 卡片右边距 | 418 / 14 / **72** | **360 / 14 / 14** |
| 390 | innerWidth / 卡片左边距 / 卡片右边距 | 418 / 14 / **42** | **390 / 14 / 14** |
| 414 | innerWidth / 卡片左边距 / 卡片右边距 | 419 / 14 / **19** | **414 / 14 / 14** |

- before：长 Tab 把布局视口撑到 418px（与设备宽无关），卡片右边距随屏宽漂移 72/42/19px、与左 14px 不对称 → **FAIL**。
- after：`innerWidth = 设备宽`、`hOverflow=0`，卡片**左右边距各屏宽恒为 14px** → **PASS**。Tab 条 `tabsOverflow`
  现落在条内（48/18/0），靠 `overflow-x:auto` 自滚，不撑页。
- 截图：`before/task-detail-360.png` `before/task-detail-414.png` vs `after/task-detail-360.png` `after/task-detail-414.png`。

## C1 / C2 / C3 实时对话布局（@360，三屏宽一致）

| 指标 | before | after（默认折叠） | after（点 ⓘ 展开） |
|---|---|---|---|
| session-meta-bar 可见 / 高度 | true / 128px | **false / 0** | true / 128px |
| ⓘ 折叠按钮可见 | —（无） | **true** | true |
| 消息区高度 | 296px | **471px** | 343px |
| 消息区滚动条 | auto | **none** | none |
| 横向溢出 hOverflow | 0 | 0 | 0 |

- before：meta-bar 占 128px（约 4 行 chip）把消息区挤到 296px、标题子信息换行 → 排列混乱、内容区小 → **FAIL**。
- after：meta-bar 默认折叠（`metaVisible=false`），消息区增至 471px（+59%）、滚动条隐藏；点 ⓘ 可逆展开（仍无横向溢出）→ **PASS**。
- 截图：`before/chat-390.png` vs `after/chat-390.png`（折叠）/ `after/chat-open-390.png`（展开）。

## B1 / B2 构建

- `npm run typecheck`：db / relay-client / console / worker / relay 五包全过 → **PASS**。
- `npm -w @claude-center/console run build`：webpack 全量构建成功，`/chat` `/tasks/[id]` 等路由正常产出、globals.css 无报错 → **PASS**。

结论：matrix.csv 全 PASS。
