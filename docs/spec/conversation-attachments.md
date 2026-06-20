# 实时对话附件（图片 / 文件）

> 兑现 `docs/spec/task-attachments.md` §边界 留的扩展位：把任务/评论已有的附件链路接到实时对话
> （`docs/spec/worker-direct-chat.md`）。复用同一套存储 / 上传 / 落地 / prompt 注入机制，仅新增
> 「绑定到对话消息」这一种多态归属。

## 需求

1. 实时对话发消息时可附加 **图片 / 文件**（截图、参考文档、日志样本…）。
2. 附件落到 Worker 的**只读会话 worktree** 后，图片以本地路径写进 prompt 让 `claude -p` 读到（vision），
   通用文件作引用资料由 Claude 按需打开——与 task / comment 完全一致。
3. 允许「仅附件、空文本」消息（粘一张截图直接发问）。
4. 不引入新依赖：仍走 `attachments` + `attachment_blobs`（DB bytea），Worker 直连 PG 取 blob。

## 现状（复用，不重写）

- `attachments` 表已有多态归属 `task_id` / `task_comment_id`（`024_task_attachments.sql`），二进制在
  `attachment_blobs`。上传两阶段：`POST /api/attachments`（未绑定）→ 创建任务/评论时事务里绑定。
- Worker 侧 `materializeAttachments` / `attachmentSection`（`apps/worker/src/executor.ts`）已能把附件落到
  worktree 的 `.claude-attachments/` 并把相对路径附到 prompt。
- 对话执行 `executeConversationTurn`：`getConversationPrompt` 取「上一已闭合 assistant 之后」的 user
  消息拼 prompt，在每会话独立的只读 worktree（检出到 `origin/<branch>`）里跑 claude。

## 改动

### 数据模型（`033_conversation_attachments.sql`）

- `attachments` 加第三种归属列 `conversation_message_id uuid REFERENCES conversation_messages(id) ON DELETE CASCADE`。
- 重建归属唯一性 CHECK（024 的匿名约束 `attachments_check` → 三选一的具名 `attachments_owner_one`）：
  `(task_id IS NOT NULL)::int + (task_comment_id IS NOT NULL)::int + (conversation_message_id IS NOT NULL)::int <= 1`。
- 新增 `attachments_conv_msg_idx`；孤儿清理索引 `attachments_orphan_idx` 重建，纳入
  `conversation_message_id IS NULL`（三种归属皆 NULL 才算未绑定孤儿）。

### DB 查询（`packages/db/src/queries.ts` + `types.ts`）

- `Attachment` 类型加 `conversation_message_id`；`ATTACHMENT_ROW_COLS` 带上该列。
- 新增 `bindAttachmentsToConversationMessage`（仿 `bindAttachmentsToComment`：仅未绑定 + 归属本用户的行可绑，
  admin 经 `ownerUserId=null` 绕过）。
- 新增 `listConversationTurnAttachments`：**锚点与 `getConversationPrompt` 完全对齐**——取「上一条 done/failed
  assistant 之后」的 user 消息绑定的附件。流式中的 assistant 不移动锚点，故 Worker 取到的恰是本轮附件。
- `bindAttachmentsTo{Task,Comment}` / `deleteUnboundAttachment` / `deleteOrphanedAttachments` 的「未绑定」判定
  补 `AND conversation_message_id IS NULL`。

### API（`apps/console/app/api/`）

- `POST /api/conversations/[id]/messages`：接 `attachmentIds?: string[]`，允许空文本仅附件；消息 + 绑定在一个事务里
  （绑定失败回滚消息，不留空消息 + 孤儿附件）；上限复用 `MAX_ATTACHMENTS_PER_OWNER`。
- `GET /api/attachments/:id` 鉴权 `canRead` 加分支：对话消息绑定的附件，经 conversation 反查 project，按项目可见性放行。

### Worker（`apps/worker/src/executor.ts`）

- `executeConversationTurn` 在只读 worktree 就绪后 `materializeAttachments(wtPath, 本轮附件)`，并把
  `attachmentSection(...)` 附到 `getConversationPrompt` 的结果后面再喂 claude。worktree 复用 → 同 sha256 跨轮跳过落盘；
  会话 `close` 移除 worktree 时 `.claude-attachments/` 一并销毁。

### Console UI（`apps/console/app/ui/chat-thread.tsx`）

- 输入区复用 `AttachmentUploader`（点击 / 拖拽 / 粘贴上传、缩略图、删除）。发送时把附件 id 一并 POST，发完清空。
- 乐观气泡由纯文本改为 `{ text, attachments }`：文本按正文匹配 jsonl 清除，仅附件消息按附件 sha256 前 8 位
  （Worker 注入 prompt 的路径片段）匹配清除。气泡内用 `AttachmentList` 展示。

## 验证

- `npm run typecheck` / `npm run build` 全绿（含 `next build`，`/chat` 路由编译通过）。
- `node scripts/ephemeral-db.mjs --verify`：33 个迁移在干净库整体应用通过 + `verify:console` 见 `401→200` 与
  `scheduler.ok:true`，临时库 `DROP ... WITH (FORCE)` 零污染。
- 约束/列/索引 ground-truth（pg_constraint / information_schema）：匿名 `attachments_check` 已被
  `attachments_owner_one`（三选一 `<=1`）取代，列 / 索引 / 注释齐备。
- 查询行为 round-trip（10 条断言全 PASS）：bind 后 `conversation_message_id` 落位；流式中 `listConversationTurnAttachments`
  仍返回本轮附件、assistant done 后归零；孤儿 GC 不误删已绑定对话附件；删会话级联删附件 + blob。

## 边界（沿用 task-attachments.md）

- MIME 白名单 + 大小 + magic bytes 嗅探在 Console API 层；无病毒扫描。
- 不支持 Worker→Console 反向上传；附件链路单向。
- 不做转码 / OCR / 缩略图压缩，原样上传。
