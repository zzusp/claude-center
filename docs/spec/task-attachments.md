# 任务与回复附件（图片 / 文件）

## 需求

1. 创建任务时可附加 **图片 / 文件**（需求截图、错误截图、参考文档、日志样本…）。
2. 回复 waiting 任务的评论时同样可附加；用户回答里贴图直接让 Claude 看到。
3. 附件落地到 Worker 的 worktree 后，**图片以本地路径写进 prompt**，让本地 `claude -p` 读到（Claude CLI 支持本地图片路径）。通用文件以路径列表写进 prompt 作引用资料，由 Claude 按需打开。
4. Console / Worker / Relay 不引入新的对象存储依赖。
5. MVP **仅覆盖 task / task_comment** 两条路径。`conversations` 二期再接入（数据模型已留扩展位）。

## 现状（已读源码确认）

- 任务描述 `tasks.description text NOT NULL`、评论 `task_comments.body text NOT NULL`（`packages/db/migrations/001_init.sql:48`、`002_task_comments.sql:17`），全是纯文本。无附件相关表。
- 任务创建 `POST /api/tasks`（`apps/console/app/api/tasks/route.ts:90`）接 `body: { projectId, title, description, ... }`，原子事务里同时落 `tasks` + `task_repos` + `task_dependencies`。
- 评论 `POST /api/tasks/[id]/comments`（`apps/console/app/api/tasks/[id]/comments/route.ts:28`）接 `{ body }`。
- Worker 拼 prompt：`taskPrompt` / `resumePrompt` / `rejectionPrompt` / `retryPrompt`（`apps/worker/src/executor.ts:263/276/288/302`），全部走 `task.description` / `reply` 字符串。Worker 进程在用户机器上跑 `claude -p`，工作目录是 `worktree-<taskId>/`（`apps/worker/src/worktree.ts`）。
- 现有发布点：所有"先落库再 publish" 经 `publishRelay` / `apps/relay`（`docs/spec/sse-relay-service.md`）。

## 关键设计抉择

> 2026-06-16 已就以下三点采用推荐方案。反向选项保留备查。

### 抉择 1：存储后端 — ✅ DB bytea（独立 `attachment_blobs` 表）

> 初稿写「Console 本地磁盘」，实施时被 Worker 架构约束推翻。

- **架构约束**：Worker 是用户电脑上的 Electron 桌面进程，**直接连 PG**（`apps/worker/src/runner.ts:14` 直接 `import { getTaskWithDeps } from "@claude-center/db"`），**没有任何 Worker→Console HTTP 调用**，更没有共享文件系统。
- **采用 — DB bytea**：metadata 行在 `attachments` 表；二进制单独放 `attachment_blobs(attachment_id pk, data bytea)`，避免 `SELECT * FROM attachments` 误拖大对象。Worker 与 Console 都走同一份 PG。
  - 零新增依赖（PG 已是双方共同信道），无需额外鉴权面（Worker→Console HTTP 不存在）。
  - 大对象 Postgres 自动 TOAST 到外存储区；对 ≤ 50MB 单文件、团队内规模可接受。
  - 单一权威：DB 即真理，不存在文件系统漂移、多 Console 实例同步问题。
- **未采用 — Console 本地磁盘 + Worker HTTP 下载**：需新建 Worker→Console 鉴权（worker token），增加面太大；对桌面 Worker 还涉及内网穿透/NAT 等运维问题。
- **未采用 — S3/MinIO**：MVP 引入第三方依赖收益不显（团队内工具）。
- **未采用 — 单一 `attachments` 表带 `data bytea`**：现有 `SELECT *` 调用会无意中拖出大对象。split 表是最低成本隔离。

### 抉择 2：上传时机 — ✅ 两阶段（先上传后绑定）

- **采用 — 两阶段**：`POST /api/attachments`（multipart）→ 拿 `attachmentId` → 创建任务 / 评论时把 `attachmentIds: string[]` 一并提交，在 task / comment 的事务里把 attachments 行更新成「已绑定」。
  - 解决"任务还没创建就要上传附件"的鸡蛋问题；前端拖拽即上传即预览，提交是单纯的元数据 POST。
- **未采用 — 单步 multipart**：任务表单变 multipart、前端复杂，且事务里夹 IO 风险大。
- 孤儿（>24h 未绑定）由 **worker 端清理 cron**（仿 `task-cleanup`）扫 `(task_id IS NULL AND task_comment_id IS NULL AND created_at < now()-'24h')`，`DELETE` 即同时删元数据与 blob（FK CASCADE）。

### 抉择 3：数据模型 — ✅ 单一 `attachments` 表（多态归属）

- **采用 — 单表多态**：`task_id` / `task_comment_id` 二选一（CHECK 约束），未来扩 `conversation_message_id` 加列即可。
- **未采用 — 双表**：近双胞胎、查询要 union；扩到 conversations 又得加第三张。

## 数据模型（migration `024_task_attachments.sql`）

- `attachments`：元数据（id / 归属 / mime / size / sha256 / original_name / created_at）。
- `attachment_blobs`：仅 `attachment_id pk` + `data bytea`。1:1 单独表，避免对 `attachments` 的 `SELECT *` 误拖二进制；FK ON DELETE CASCADE 保证元数据与 blob 同生共死。

具体 DDL 见 `packages/db/migrations/024_task_attachments.sql`。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/attachments` | `multipart/form-data` 单文件；写元数据 + blob；返回 `{ id, kind, mime, size, name, sha256 }`。鉴权：登录用户。|
| `GET` | `/api/attachments/:id` | 回传二进制（`Content-Type: <mime>` + `Content-Disposition: inline; filename=<original_name>`），从 DB blob 读。鉴权：admin / 上传者本人 / 已绑定任务的项目可见者。**Worker 不走此路径，直接读 PG**。|
| `DELETE` | `/api/attachments/:id` | 仅未绑定时允许（前端撤销刚上传的附件）；绑定后通过删 task / comment 级联删除。|
| `POST /api/tasks` | (改) | body 增 `attachmentIds?: string[]`，事务里 `UPDATE attachments SET task_id=$task WHERE id = ANY($ids) AND task_id IS NULL AND task_comment_id IS NULL AND owner_user_id = $current_user`。命中行数不等于请求数 → 400。|
| `POST /api/tasks/:id/comments` | (改) | 同上，绑 `task_comment_id`。允许"仅附件、空文本"。|
| 返回体 | `Task` / `TaskComment` | 加 `attachments?: AttachmentMeta[]`。|

校验：

- MIME 白名单：图片 `image/png|jpeg|webp|gif`；文件 `application/pdf|text/plain|text/markdown|application/zip|application/octet-stream|application/json`。其它 415。
- 真实嗅探：上传时读首 16 字节做 magic bytes 校验（图片必查；通用文件至少拒绝 Windows PE / Mach-O / ELF 等可执行）。
- 大小：图片 ≤ 10MB，文件 ≤ 50MB（`CLAUDE_CENTER_UPLOAD_MAX_IMAGE_MB` / `CLAUDE_CENTER_UPLOAD_MAX_FILE_MB` 可调）。
- 单次任务/评论附件数 ≤ 10。
- 文件名：清洗 `..` / 路径分隔符 / 控制字符；长度截到 200。

## Worker 流程

1. **fetch**：现有 `runner` 经 `@claude-center/db` 直连 PG；`getTaskWithDeps` / `listTaskComments` 现已返回 `attachments` 元数据。
2. **落地**：worktree 内 `mkdir -p .claude-attachments/` → 对每个附件用新增的 `getAttachmentBlob(client, id)` 直接 SELECT bytea → 文件名按 `<sha256-short>-<sanitized_original_name>` 落盘。已存在（同 sha256）跳过 SELECT。
3. **prompt 注入**：`executor.ts` 拼 prompt 时在 description 后追加段落：

   ```
   Attached files (already saved locally, read them as needed):
   - ./.claude-attachments/abc12345-screenshot.png (image/png, 124 KB)
   - ./.claude-attachments/def67890-spec.md (text/markdown, 8 KB)
   ```

   续接 / 重试 / 打回 prompt 同样附录当前轮的 attachments。

4. **清理**：worktree GC（`apps/worker/src/worktree.ts`）整目录删时 `.claude-attachments/` 一并销毁；不持久化。
5. **续接续传**：waiting 任务收到用户回复评论时，回复的 attachments 同样下载到 `.claude-attachments/`（同 sha256 跳过），prompt 段同样附录。

## Console UI

- 共用组件 `apps/console/app/ui/attachment-uploader.tsx`：
  - `AttachmentUploader`：拖拽 + `onPaste` 抓 `clipboardData.files` + 点击上传；缩略图（图片）/ 文件 chip（其它）；上传中显进度，删除走 `DELETE /api/attachments/:id`。
  - `AttachmentList`：只读展示（图片支持点击 lightbox，文件下载链接）。
- 集成点：
  - `tasks-compose.tsx`（任务创建表单）：description 下方加 uploader（hidden input attachmentIds JSON）。
  - `task-detail-overview.tsx`：description 下方展示 `AttachmentList`。
  - `task-detail-conversation.tsx`（评论流）：每条 comment 渲染 `AttachmentList`；回复框集成 uploader。
- 编辑任务时增删附件 **不在 MVP**（创建表单 / 评论框已是覆盖最广的入口）；二期通过 PATCH /api/tasks/:id 接受 `attachmentIds` 即可。

## 验证

静态（本会话可跑）：
- `npm run typecheck`
- `npm run build`
- `npm run verify:console`（必须看到 `401→200` 与 `scheduler.ok:true`）

端到端（需 Postgres + claude CLI + 真实任务，本环境无法跑，列步骤）：

1. `npm run db:ephemeral --verify` 走一次干净库迁移 + verify:console。
2. UI 创建任务：上传一张错误截图 + 一份 markdown 文件，描述里要求"分析截图给出修复"。发布。
3. Worker 接任务后 `.claude-attachments/` 应有两文件；`claude -p` 输出体现对截图的描述（vision OK）。
4. Worker 在 prompt 末尾哨兵停下 → 用户在 Console 回复评论 + 附第二张图 → Worker 续接同会话 → 输出体现对第二张图的描述。
5. 任务完结后，对应 worktree GC 触发 `.claude-attachments/` 被一并销毁；DB 行随 task 删除级联消失。

## 边界

- **不支持** 直接拖入文件夹、压缩包内文件预览。
- **不支持** 图片粘贴自带 OCR / 缩略图压缩（前端不做转码，原样上传）。
- **不支持** Worker → Console 反向上传（Claude 产出的截图归在 PR / commit 里，附件链路单向）。
- **conversations 不在 MVP**：表结构已为之留扩展位（加 `conversation_message_id` + 调 CHECK 即可），二期实施。
- **不引入** 病毒扫描：MVP 仅 MIME + 大小 + 简单 magic bytes；团队内工具，可接受风险。
