-- 022: 失败/取消任务的「续接重试」请求标记。
-- 用户在 UI 点「重试」时由 requestTaskRetry 置 retry_requested_at=now()；Worker 的
-- claimNextRetryableTask 据此认领（status IN ('failed','cancelled') AND retry_requested_at IS NOT NULL）
-- 翻为 running 并清空该戳。区分「用户主动请求重试」与「停在失败/取消态」，避免被动全量重试。
-- 无状态机变更（failed/cancelled → running 复用既有 running 态），故不重建 tasks_status_check。
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS retry_requested_at timestamptz;

-- 重试认领队列：只扫已请求重试的任务（极小子集），按 claimed_by 机器锁定续接同机工作树/会话。
CREATE INDEX IF NOT EXISTS tasks_retry_request_idx
  ON tasks(claimed_by)
  WHERE retry_requested_at IS NOT NULL;
