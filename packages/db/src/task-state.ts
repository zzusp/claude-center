// 任务状态机的单一出处:合法状态全集 + 语义分组 + 状态转换时清空的字段说明。
// 取代散落各处的硬编码状态字符串(console 过滤白名单、queries 里的 IN(...) 片段),改一处即同步,
// 避免并行分支各自加状态时互相漏掉(CLAUDE.md「CHECK 全集重建」坑)。
import type { TaskStatus } from "./types.js";

// 全部合法任务状态。与 types.ts 的 TaskStatus 联合一一对应——新增状态时两处同步,
// TS 的 satisfies 在此保证两边不漂移(漏一个会编译报错)。
export const TASK_STATUSES = [
  "draft",
  "scheduled",
  "pending",
  "claimed",
  "running",
  "waiting",
  "success",
  "merged",
  "failed",
  "cancelled"
] as const satisfies readonly TaskStatus[];

// 在途占用 worker 的计数态(claimed/running):listWorkers 的 active_task_count、删除护栏用。
export const ACTIVE_WORKER_STATUSES = ["claimed", "running"] as const satisfies readonly TaskStatus[];

// 在途(已认领但未达终态,可被取消):claimed/running/waiting。取消护栏、worktree 持有判定用。
export const IN_FLIGHT_STATUSES = ["claimed", "running", "waiting"] as const satisfies readonly TaskStatus[];

// 「已完成」终态:依赖门控据此判定前置是否放行。
// 取消「人工验收」后:success(Worker 已交付,即视作完成)与 merged(PR 已合并落地)均算完成,
// 后续任务可被领取。push 模式终态仍是 success(无 PR 可合)。
export const COMPLETED_STATUSES = ["success", "merged"] as const satisfies readonly TaskStatus[];

// 可重新激活回草稿的状态(reactivateTask)。
export const REACTIVATABLE_STATUSES = ["failed", "cancelled"] as const satisfies readonly TaskStatus[];

// 可「续接重试」的终态(requestTaskRetry / claimNextRetryableTask):失败或被取消的任务,
// 保留工作树 + Claude 会话,带着失败原因/中断点续接重跑。与 REACTIVATABLE 同集合但语义不同
// (重试=带上下文接着干;激活=清空回草稿推倒重来),分别命名以免改一处误伤另一处。
export const RETRYABLE_STATUSES = ["failed", "cancelled"] as const satisfies readonly TaskStatus[];

// 终态中「可经用户回复直接续接」的集合(success/merged/failed/cancelled——均在 listActiveTaskIdsForWorker
// 的工作树保留名单内)。用户在任务详情对这些「非在途」任务回复 → 落库后由 Worker 的 claimNextResumableTask
// 认领走 resumeTask:有 claude_session_id 则 resume 同一会话续接,无会话(如失败在 worktree 准备阶段、Claude
// 还没产出 session)则带用户补充全新执行——不再要求会话非空,失败任务也允许补一句话接着干。
// draft/scheduled/pending 尚未执行,不在此列。与 RETRYABLE 部分重叠但触发与续接方式不同:此处由「用户回复」
// 触发、带回复内容走 resumeTask;RETRYABLE 由「重试」按钮触发、用 retryPrompt 走 retryFailedTask。
export const REPLYABLE_TERMINAL_STATUSES = [
  "success",
  "merged",
  "failed",
  "cancelled"
] as const satisfies readonly TaskStatus[];

// 可发布 / 退回门控涉及的待发状态(draft 人工发布、scheduled 到点/提前发布)。
export const PUBLISHABLE_STATUSES = ["draft", "scheduled"] as const satisfies readonly TaskStatus[];

// 把状态集合渲染为 SQL IN 列表片段(如 "'claimed', 'running'")。
// 入参恒为本文件内的枚举字面量(非用户输入),字符串插值安全;用于保持 queries.ts 里
// `status IN (${sqlInList(X)})` 与原硬编码字节等价,同时让分组有名可循。
export function sqlInList(statuses: readonly TaskStatus[]): string {
  return statuses.map((status) => `'${status}'`).join(", ");
}

// reactivateTask 把任务退回 draft 时清空的「执行运行态」字段全集(与任务定义字段相对)。
// 文档化于此:任务表字段横跨「定义 / 认领 / 执行 / PR 清理 / 取消 / 续接会话」多组,
// 退回草稿即抹掉除「定义」外的全部运行痕迹。新增运行态列时,记得同步加入此列表 + reactivateTask。
export const TASK_RUNTIME_FIELDS = [
  "scheduled_at",
  "claimed_by",
  "claimed_at",
  "started_at",
  "finished_at",
  "error_message",
  "result",
  "pr_url",
  "merge_status",
  "merge_status_checked_at",
  "merge_checked_at",
  "claude_session_id",
  "cancel_requested_at",
  "retry_requested_at"
] as const;
