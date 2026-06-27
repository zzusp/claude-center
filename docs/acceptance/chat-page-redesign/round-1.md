# round 1 —— 实时对话页重设计

## 命令

```powershell
# 1) 起 ephemeral DB 跑全量迁移
node scripts/ephemeral-db.mjs --keep
# → 输出 connection string，赋给 $env:DATABASE_URL

# 2) typecheck + build
npm run typecheck
npm run build

# 3) 启动 dev server 并对临时库做 401→200 + scheduler.ok 自检
$env:DATABASE_URL = "<ephemeral url>"; $env:CONSOLE_PORT = "3030"; npm run verify:console

# 4) 截图（脚本会再起一次 dev server + seed + 用 Playwright 截 5 张）
$env:DATABASE_URL = "<ephemeral url>"; $env:CONSOLE_PORT = "3030"; \
  node docs/acceptance/chat-page-redesign/scripts/take-chat-screenshots.mjs

# 5) 清理临时库
# node 临时脚本 DROP DATABASE "<name>" WITH (FORCE)
```

## 关键观察

* `npm run build` 报告路由表新增 `/chat` 与 `/chat/[projectId]` 两条 dynamic route。
* `verify:console` 末尾 `scheduler.ok: true`，证明 instrumentation 拆分仍生效（未改动该路径，但 build 路径全量重跑）。
* 截图 03 列出三点菜单，证实「重命名 / 对话设置 / 删除对话」三项落实，且没有「结束对话」。
* 截图 05 进入对话后展开顶部 More 菜单，四项全部为 `重命名 / 对话设置 / 会话信息 / 删除对话`；与改动前对比，原本第 4 项的「结束对话」已彻底移除。

## 证据

| 文件 | 说明 |
| ---- | ---- |
| `round-1/01-chat-projects.png` | `/chat` 项目网格（三张卡片：claude-center / feature-platform / infra-runbooks） |
| `round-1/02-chat-project-list.png` | `/chat/[id]` 项目工作台：左侧三条会话仅显示标题；右侧「请选择会话」空态 |
| `round-1/03-chat-li-menu.png` | 列表项三点菜单展开 → 重命名 / 对话设置 / 删除对话 |
| `round-1/04-chat-thread-empty.png` | 选中第一条会话后激活态 + 右侧消息线（暂无消息） |
| `round-1/05-chat-thread-menu.png` | 头部 More 菜单展开，验证「结束对话」已被移除 |
