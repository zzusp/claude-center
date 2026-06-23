# Round 1 — 新建对话弹窗加宽 + 双列表单

复现：`node docs/acceptance/chat-new-modal-layout/scripts/shot.mjs`
产物：`after/new-conversation-{desktop,mobile-360,mobile-390,mobile-414}.png` + `after/probe.json`

## probe 断言（CDP 真实视口）

| view | innerWidth | modalWidth | bodyGridColumns | projBranchSideBySide | hOverflow |
|------|-----------:|-----------:|-----------------|----------------------|----------:|
| desktop   | 1024 | **560** | `256px 256px` | **true**  | 0 |
| mobile-360 | 360 | 320 | `286px`(单列) | false | 0 |
| mobile-390 | 390 | 350 | `316px`(单列) | false | 0 |
| mobile-414 | 414 | 374 | `340px`(单列) | false | 0 |

- 桌面 `halfTops=[250,250,327,327]`：项目+分支同顶(250)并排、Worker+模型同顶(327)并排 → 双列成立。
- 手机 `halfTops=[187,262,339,414]`：四个半宽字段各自独立行 → 单列回落成立。
- 四档 `hOverflow=0` → 无横向溢出。

## 截图

- `after/new-conversation-desktop.png`：560 宽，项目|分支、Worker|模型 两两并排，长字段整行。
- `after/new-conversation-mobile-390.png`：满宽单列，字段顺序保持，无裁切 / 溢出。

## 结论
全部 PASS。`npm run typecheck` 五包绿。
