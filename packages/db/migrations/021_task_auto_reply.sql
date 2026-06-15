-- 021: 任务级「自动回复」开关与决策预案。
-- auto_reply=true 时，Worker 会切换激进版 prompt（把哨兵重新定义为"任务被判定 blocked"），
-- 把 auto_decision_hints（如果填了）一起注入 prompt 作为用户预先编码的决策偏好。
-- 兜底行为见 apps/worker/src/executor.ts：哨兵 + 零改动→fail；哨兵 + 有改动→自动回复 + cap=2。
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS auto_reply boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_decision_hints text NOT NULL DEFAULT '';
