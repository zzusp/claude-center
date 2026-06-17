# 验收方案：移除「已验收 / 已打回」状态

## 需求

ClaudeCenter 任务状态过多（success/merged/accepted/rejected/failed/cancelled），用户反馈尤其是「已完成
之后的状态混乱」。简化方案：

1. 去掉「已验收」(accepted) 状态、人工验收步骤、批量验收功能。
2. Worker 终态只剩 **success / failed / waiting** 三种，不再有 accepted。
3. Console 每 30s 轮询所有「已完成且有 PR」的任务，PR 已合并即翻 merged，**不再清理 worktree**。
   没有 PR 的 success 就是最终终态。
4. 任务调度列表支持「提交模式」(submit_mode = pr / push) 的筛选。

## 改动

完整方案与文件级清单见 [docs/spec/drop-accepted-rejected.md](../../spec/drop-accepted-rejected.md)。

主要改动：
- `packages/db`：去除 accepted/rejected 类型与相关 helpers；新增 028 迁移做数据映射 + 重建 CHECK。
- `apps/worker`：删除 `cleanupMergedTask` / `rerunRejectedTask` / accept-reject IPC 与 UI；push 模式
  终态从 markTaskMerged 改为 markTaskSuccess。
- `apps/console`：删除 `/api/tasks/[id]/review`；定时合并循环改为 success+PR → merged（30s 间隔）；
  UI 状态/批量动作/详情/统计字段同步更新；任务列表新增提交模式筛选。
- `scripts/smoke-bulk-actions.mts`：去掉 accept 用例。

## 验证矩阵

见 [matrix.csv](./matrix.csv)；证据在 [round-1.md](./round-1.md)。
