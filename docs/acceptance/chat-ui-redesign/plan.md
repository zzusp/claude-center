# 实时对话 UI 重构（按参考图）

## 需求

参考图（`.claude-attachments/3752ecbd-...png`）展示了 Claude 网页版项目侧栏样式：
- 顶部 `项目` 标题
- 项目列表（文件夹图标 + 名称）
- 选中项目内嵌展开该项目下的会话历史（标题 + 相对时间）
- 选中行有 ⌄ 折叠箭头 + 悬停态的 `⋯` 更多菜单 + 新建对话按钮
- 多条历史下方有「展开显示」入口

## 方案

### 路由 / 布局

- `/chat` 与 `/chat/[projectId]` 共用一份 `ChatShellClient`：
  - `/chat` → 进入时无项目展开；
  - `/chat/[projectId]` → 进入时按 projectId 自动展开；
  - `/chat/[projectId]?c=<convId>` → 在上一步基础上选中该会话，右侧出现消息线。
- 项目展开 / 会话切换通过 `router.replace` 同步到 URL，刷新 / 分享 / 浏览器后退键自然还原。
- 旧的 cowork 项目卡片网格首页彻底删除；项目选择融入侧栏。

### 组件结构

- `apps/console/app/ui/chat-sidebar.tsx`（新增）：受控的项目树侧栏；
  - 项目行 = 文件夹图标 + 名称 + 尾部容器（展开态 chevron + 悬停态 ⋯ 与 ✏ 新建对话按钮）；
  - 展开后内嵌该项目的会话历史列表，单条 = 标题 + 相对时间（`relTime()` 内置实现）；
  - 超过 5 条时显示「展开显示」一次性放开剩余；
  - 单条会话三点菜单：重命名（行内 input）/ 对话设置 / 删除对话；
- `apps/console/app/ui/chat.tsx`（重写）：`ChatView` 改为容器组件，组合 `ChatSidebar` + 右侧 `ChatThread` / 空态，
  - 内部管理 `expandedProjectId` / `activeConvId` / 会话列表轮询；
  - 暴露 `onProjectChange` / `onConversationChange` 给上层做 URL 同步；
- `apps/console/app/(app)/chat/chat-shell-client.tsx`（新增，取代原先的两份 client）：拉取 projects + workers，把 URL 同步成 router.replace 行为；
- `(app)/chat/page.tsx` 与 `(app)/chat/[projectId]/page.tsx` 都渲染 ChatShellClient，仅传入 `initialProjectId` / `initialConversationId` 差异。

### 删除

- `apps/console/app/ui/chat-projects.tsx`（cowork 卡片网格视图）
- `apps/console/app/(app)/chat/chat-projects-client.tsx`
- `apps/console/app/(app)/chat/[projectId]/chat-client.tsx`
- 旧 CSS：`.chat-list*`、`.chat-li*`、`.chat-li-simple*`、`.chat-li-more*`、`.chat-li-dropdown*`、`.chat-filter*`、`.chat-projects*`（除 `.chat-projects-loading` 仍作 loading 占位）、`.chat-project-card*`、`.chat-back-projects` 等。

## 改动

- 新增：
  - `apps/console/app/ui/chat-sidebar.tsx`
  - `apps/console/app/(app)/chat/chat-shell-client.tsx`
  - `docs/acceptance/chat-ui-redesign/scripts/take-chat-screenshots.mjs`
- 修改：
  - `apps/console/app/ui/chat.tsx`（重写 ChatView 使用侧栏）
  - `apps/console/app/(app)/chat/page.tsx`、`apps/console/app/(app)/chat/[projectId]/page.tsx`（改用共享 client）
  - `apps/console/app/globals.css`（新增 `.chat-side*` 系列、删除旧 `.chat-list*` `.chat-li*` `.chat-projects*` 等；mobile 主从切换从 `.chat-list` 改为 `.chat-side`）
- 删除：
  - `apps/console/app/ui/chat-projects.tsx`
  - `apps/console/app/(app)/chat/chat-projects-client.tsx`
  - `apps/console/app/(app)/chat/[projectId]/chat-client.tsx`

## 验证

`docs/acceptance/chat-ui-redesign/scripts/take-chat-screenshots.mjs`：

1. `01-chat-sidebar.png` —— `/chat`：项目树侧栏（无展开），右侧空态文案
2. `02-chat-sidebar-expanded.png` —— `/chat/[claude-code-session-id]`：sidebar 展开并显示 5 条会话历史
3. `03-chat-conv-menu.png` —— 会话项三点菜单展开（重命名 / 对话设置 / 删除对话）
4. `04-chat-thread-replied.png` —— 端到端：脚本直接 import `@claude-center/db` dist 的 helpers
   推一轮 user → assistant，UI 拉到 jsonl + 消息渲染，验证侧栏 + 数据通道在真实状态机下都能跑

外加：
- `npm run typecheck` 全绿（db / relay-client / console / worker / relay）
