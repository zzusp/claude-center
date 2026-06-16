-- 024_task_attachments.sql
-- 任务/评论附件（图片+文件）。方案见 docs/spec/task-attachments.md
--
-- 兼容：旧 task / task_comment 行不动；attachments 表空时老前端不读 attachments 字段也能正常工作。
-- 关键不变量：单文件最大 50MB（图片 10MB）；MIME 白名单 + magic bytes 嗅探在 Console API 层做；
-- 二进制存 DB（attachment_blobs.data bytea，PG 自动 TOAST），因 Worker 直连 PG 没有 HTTP 通道也没有
-- 共享文件系统——这是与 Console 本地磁盘方案的取舍点（spec 抉择 1）。
-- 元数据与 blob 1:1 分表，避免 SELECT * FROM attachments 误拖大对象。

CREATE TABLE IF NOT EXISTS attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 多态归属（二选一），未来扩 conversation_message_id 加列 + 改 CHECK 即可。
  task_id          uuid REFERENCES tasks(id)         ON DELETE CASCADE,
  task_comment_id  uuid REFERENCES task_comments(id) ON DELETE CASCADE,
  -- 上传期归属（未绑定时记上传者，配合 created_at 给孤儿清理用）。
  owner_user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('image','file')),
  mime             text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  -- 内容寻址：相同 sha256 表示相同二进制（Worker 端缓存判定用）。
  sha256           text NOT NULL,
  original_name    text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- 至多一种归属（未绑定则两列都为 NULL）
  CHECK ((task_id IS NOT NULL)::int + (task_comment_id IS NOT NULL)::int <= 1)
);

CREATE INDEX IF NOT EXISTS attachments_task_idx
  ON attachments(task_id, created_at)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS attachments_comment_idx
  ON attachments(task_comment_id, created_at)
  WHERE task_comment_id IS NOT NULL;

-- 孤儿清理用索引：未绑定 + 按上传时间扫
CREATE INDEX IF NOT EXISTS attachments_orphan_idx
  ON attachments(owner_user_id, created_at)
  WHERE task_id IS NULL AND task_comment_id IS NULL;

-- Blob 1:1。删 attachments 行同时删 blob；不允许只删 blob。
CREATE TABLE IF NOT EXISTS attachment_blobs (
  attachment_id uuid PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  data bytea NOT NULL
);
