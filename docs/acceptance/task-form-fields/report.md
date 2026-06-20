# 验收报告：新建任务弹窗恢复原样式 + 表单优化

全绿。日期：2026-06-20。

## 静态 / 编译

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（5 包） | `npm run typecheck` | PASS |
| 全量构建（含 next webpack build） | `npm run build` | PASS（`/tasks`、`/tasks/[id]` 均构建出） |

## 运行时（一次性干净库，零污染）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| Console 启动 + 鉴权 + 调度器 | `node scripts/ephemeral-db.mjs --verify`（`CONSOLE_PORT=3987`） | PASS：`unauthDashboardStatus:401`、`loginStatus:200`、`pageStatus:200`、`health.db.ok:true`、`scheduler.ok:true`；用完 `DROP ... WITH (FORCE)` |

## 前置任务编辑后端闭环（`scripts/verify-deps.mjs`）

干净库 `--keep` 建库 → 起 dev console（`CONSOLE_PORT=3988`）→ 登录 admin → 建项目 + 任务 A/B/C → 断言 → 删库。

```
✓ PASS  admin 登录 200
✓ PASS  建项目 201
✓ PASS  建 A/B/C
✓ PASS  C 初始前置=[A]              # 新建(compose)带 dependsOn 落库
✓ PASS  update dependsOn=[A,B] 200
✓ PASS  替换后前置=[A,B]            # 编辑整批替换
✓ PASS  update 省略 dependsOn 200
✓ PASS  省略后前置仍=[A,B]（保持）  # undefined 语义=保持不变
✓ PASS  update dependsOn=[] 200
✓ PASS  清空后前置=[]              # 显式空数组=清空

结果：10/10 PASS
```

## 复现

```powershell
npm run typecheck
npm run build
$env:CONSOLE_PORT="3987"; node scripts/ephemeral-db.mjs --verify

# 依赖编辑闭环：
$out = node scripts/ephemeral-db.mjs --keep --name claude_center_depstest_run
# 取上面打印的连接串：
$env:DATABASE_URL="<上面的连接串>"; $env:CONSOLE_PORT="3988"
node docs/acceptance/task-form-fields/scripts/verify-deps.mjs
# 删库：DROP DATABASE "claude_center_depstest_run" WITH (FORCE);
```

## 未覆盖 / 盲点

- 纯视觉像素未截图（modal 需点击交互打开，且本机无 puppeteer/ws，手搓 CDP 客户端成本过高）。
  视觉正确性由「webpack 构建通过 + 类型检查通过 + 复用既有设计系统原子（cc-select / StatusBadge / form-section）」间接保证。
