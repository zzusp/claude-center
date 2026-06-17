-- 028_drop_accepted_rejected.sql
-- 移除「已验收 / 已打回」状态:任务后置流程简化为「Worker 终态 success/failed/waiting →
-- Console 30s 轮询 success+PR → 检测到合并即翻 merged」,不再有人工验收/打回环节,也不再清理 worktree。
-- 方案见 docs/spec/drop-accepted-rejected.md。
--
-- 历史数据映射:
--   accepted → merged   (人工验收通过等同于「视作已落地」的终态,与 PR 检测合并归入同一终态)
--   rejected → failed   (用户曾要求打回:并入 failed,用户可走「续接重试 / 激活回草稿」继续推进;
--                         打回意见已留在 task_comments,事件流亦保留,事后排查不丢)
--
-- 顺序:先 UPDATE 历史行映射,再重建 CHECK 约束(否则旧值会违反新 CHECK)。

UPDATE tasks
   SET status = 'merged',
       merge_status = CASE WHEN merge_status = 'unknown' THEN 'merged' ELSE merge_status END,
       updated_at = now()
 WHERE status = 'accepted';

UPDATE tasks
   SET status = 'failed',
       error_message = COALESCE(NULLIF(error_message, ''),
                                'Historical rejection: 任务曾被人工打回(原 status=rejected),' ||
                                '本次迁移并入 failed,可在任务详情用「续接重试 / 激活回草稿」继续。'),
       finished_at = COALESCE(finished_at, updated_at),
       updated_at = now()
 WHERE status = 'rejected';

-- 重建 tasks_status_check:列出当前全部合法状态(全集)。原 007/009 已添加 scheduled/draft/merged/etc,
-- 本次去掉 accepted/rejected。
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN (
    'draft', 'scheduled', 'pending', 'claimed', 'running', 'waiting',
    'success', 'merged', 'failed', 'cancelled'
  ));

-- 列注释同步:tasks.status 合法取值集合(枚举列硬规范,见 CLAUDE.md「迁移」章节)。
COMMENT ON COLUMN tasks.status IS '任务状态:draft / scheduled / pending / claimed / running / waiting / success(Worker 已交付) / merged(PR 已检测到合并) / failed / cancelled。';
