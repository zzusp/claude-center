-- 取消在途任务:新增 cancel_requested_at 取消请求时间戳。
-- 'cancelled' 状态自 001_init 起就在合法集内,本迁移纯 additive、无需重建 status 约束。
--
-- 流程:Console 对在途任务(claimed/running/waiting)打 cancel_requested_at=now();
-- Worker 周期扫描自己名下被请求取消的任务,杀掉 Claude 进程并把任务翻为终态 'cancelled'。
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
