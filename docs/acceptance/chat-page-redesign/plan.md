# 实时对话页重设计

## 需求

1. `/chat` 改成项目入口（Claude 桌面端 cowork 风格）：先按项目分类，点项目进入项目工作台；项目工作台保留会话列表 + 选中对话的消息线两栏布局。
2. 删除「结束对话」功能。原 `closed` 状态不再使用，对话能力简化为「正在进行」与「已删除」两态。
3. 项目工作台左侧会话列表精简为 Claude 网页版风格：每条只展示会话名 + 右侧三点菜单。三点菜单提供「重命名 / 对话设置 / 删除对话」。

## 方案

### 路由

| 路径 | 行为 |
| ---- | ---- |
| `/chat` | 项目网格（cowork 卡片）。点击卡片跳到 `/chat/[projectId]` |
| `/chat/[projectId]` | 项目工作台：左列出该项目下会话、右侧消息线 |

* `shell.tsx` 的菜单高亮改成前缀匹配（`/chat/...` 仍然高亮「实时对话」）。
* 项目工作台头部「返回项目列表」用 `ArrowLeft`，与原移动端的 `ChevronLeft`（返回会话列表）语义区分。

### 数据流

* `/chat` 客户端组件 `ChatProjectsClient` 挂载即拉一次 `/api/projects`，不轮询；
* `/chat/[projectId]` 客户端 `ChatProjectClient` 在内存里把 `projectId` 锁死，调用既有 `/api/conversations?projectId=<id>` 进行筛选；
* 会话列表轮询节奏沿用 `POLL_INTERVAL_MS`，三点菜单的「重命名 / 设置 / 删除」都直接复用既有的 `/api/conversations/:id` PATCH/DELETE 端点（不新增 API）。

### 「结束对话」移除

* 删除 `apps/console/app/api/conversations/[id]/close/route.ts` 端点和 `packages/db/src/queries.ts:closeConversation`。
* `apps/console/app/api/conversations/[id]/messages/route.ts` 不再检查 `conversation.status !== 'active'`：所有未删除的对话都可继续发消息。
* `chat-thread.tsx` 移除 `closed` 派生态、「对话已结束」横幅、菜单里的「结束对话」项；改为「删除对话」（复用 `useConfirm`）。
* 数据库 `conversations.status` 列保留（DB 兼容、防止已经入库的 `closed` 记录被废）；前端不再写入 `closed`。

### 会话列表项

* 新 CSS class `chat-li-simple`：单行 padding、无边框、hover/active 用 `background` 与左侧高亮；
* 三点按钮 `chat-li-more` 默认透明，hover 整行或行处于 active 时亮起；
* 三点菜单 `chat-li-dropdown` 与已有 `chat-head-dropdown` 同风格。
* 行内重命名直接复用一个 input + 回车/失焦提交（不开模态）；「对话设置」复用 `ConversationSettingsModal`（从 `chat-thread.tsx` 中提升为 export）；删除走既有 `useConfirm`。

## 改动

* 新增：
  * `apps/console/app/(app)/chat/page.tsx`（项目网格首页）
  * `apps/console/app/(app)/chat/chat-projects-client.tsx`
  * `apps/console/app/ui/chat-projects.tsx`
  * `apps/console/app/(app)/chat/[projectId]/page.tsx`
  * `apps/console/app/(app)/chat/[projectId]/chat-client.tsx`
* 修改：
  * `apps/console/app/ui/chat.tsx`（重写 `ChatView`，按项目锁定 + 简化列表项 + 行内三点菜单）
  * `apps/console/app/ui/chat-thread.tsx`（删除「结束对话」、移除 `closed`、新增「删除对话」菜单项、export `ConversationSettingsModal`、`NewConversationPanel` 新增 `lockedProjectId`）
  * `apps/console/app/ui/shell.tsx`（菜单高亮前缀匹配子路由）
  * `apps/console/app/api/conversations/[id]/messages/route.ts`（去掉 status 校验）
  * `apps/console/app/globals.css`（新增 `.chat-projects*` / `.chat-li-simple*` / `.chat-li-more*` / `.chat-li-dropdown*` / `.chat-back-projects` 等）
* 删除：
  * `apps/console/app/api/conversations/[id]/close/route.ts`
  * `packages/db/src/queries.ts:closeConversation`
  * `apps/console/app/(app)/chat/chat-client.tsx`（被新的项目工作台 client 取代）

## 验证

`docs/acceptance/chat-page-redesign/scripts/take-chat-screenshots.mjs` 把 ephemeral DB + dev server + Playwright 跑通，落 6 张证据：

1. `01-chat-projects.png` —— `/chat` 项目网格首页
2. `02-chat-project-list.png` —— `/chat/[id]` 会话列表（左）+ 右侧空态
3. `03-chat-li-menu.png` —— 列表项三点菜单展开（重命名 / 对话设置 / 删除对话）
4. `04-chat-thread-empty.png` —— 选中会话后右侧出现消息线、激活态高亮左侧
5. `05-chat-thread-menu.png` —— 会话头部 More 菜单展开，确认**已无「结束对话」项**
6. `06-chat-thread-replied.png` —— **端到端 Worker 应答流**：脚本直接 import `@claude-center/db` dist 的 helpers（`addConversationMessage` → `claimNextConversationTurn` → `upsertConversationSession` → `finalizeConversationTurn`），跟真实 Worker 走同一份代码路径推 DB；UI 通过既有的 `/api/conversations/[id]` + `/api/conversations/[id]/session` 轮询拉到，渲染出 user + assistant 气泡，证明改后页面 + 数据通道在真实状态机下都能跑

外加：

* `npm run typecheck` 全绿（db / relay-client / console / worker / relay）
* `npm run build` 全绿（含 `/chat`、`/chat/[projectId]` 两条路由）
* `npm run verify:console` 在 ephemeral DB 上跑通：401→200，`scheduler.ok: true`
