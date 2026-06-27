# round-1 — 2026-06-27

## 环境
- worktree: `worktree-f4c2afbd-...`
- DATABASE_URL: ephemeral 临时库（`scripts/ephemeral-db.mjs --keep`）
- dev server: `next dev --turbopack` on `127.0.0.1:3030`

## 步骤
1. `npm run typecheck` —— 全绿。
2. `npm -w @claude-center/db run build` + `npm -w @claude-center/relay-client run build` —— 把两个被 `apps/console` 经路由间接引用的包先 build 出 dist。
3. 起 ephemeral DB（已跑全部 38 个迁移），把连接串喂给截图脚本。
4. `node docs/acceptance/chat-ui-redesign/scripts/take-chat-screenshots.mjs` 自动起 dev server、登录、seed 演示数据（8 项目 + 1 worker + 5 会话），用 playwright 截 4 张图。
5. 第 4 张前用 `driveWorkerReply` 直接 `import` `@claude-center/db` dist，按 Worker 实际状态机推一轮 user → assistant 应答（addConversationMessage → claimNextConversationTurn → upsertConversationSession → finalizeConversationTurn），UI 通过既有 `/api/conversations/[id]/session` 拉到 jsonl 渲染。

## 证据
- `round-1/01-chat-sidebar.png` —— `/chat` 项目树侧栏 PASS：8 个项目按 git/non-git 分图标，右侧空态「选择左侧项目展开会话历史」。
- `round-1/02-chat-sidebar-expanded.png` —— claude-code-session 展开 PASS：标题加粗 + ⌄ chevron + 内嵌 5 条会话历史（标题 + 相对时间），后续 card-story / project / 2ef704f2 仍折叠。
- `round-1/03-chat-conv-menu.png` —— 会话项三点菜单 PASS：「重命名 / 对话设置 / 删除对话（红）」。
- `round-1/04-chat-thread-replied.png` —— 端到端 Worker 应答 PASS：选中会话后右侧出现完整消息线，user 气泡 + assistant 文本渲染、底部 composer 在线。

## 已知 deviation
- 参考图项目行右侧有「⋯」 + 新建对话按钮在 hover 时出现；截图 02/04 未触发 hover 故按钮未亮（CSS hov-only 默认 opacity:0）。展开态本身的 ⌄ chevron 与文件夹色加深都有体现。
