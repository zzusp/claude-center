// 行为冒烟：已完成任务（success / merged）的续跑机制（PR-B）
// - continueTask 原子翻 claimed + continuation_count++ + 写 user 评论 + 'continuation_requested' 事件
// - claimNextContinuationTask 翻 running + 清 continuation_requested_at + 写 'continuation_started' 事件
// - getPendingContinuationNote 取本轮 user 评论
// - getTaskStatusById 单查（gcWorktrees TOCTOU 二次校验用）
// - updateTaskRepoBranchAndResetPr / setTaskWorkBranch（case B 切 -cont-N 新分支）
// - 守卫：非 success/merged 状态发起 continueTask 返回 null（API 端将翻 409）
//
// 由 run-smoke-against-ephemeral.mjs 触发：
//   node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-task-continuation.mts
import {
  claimNextContinuationTask,
  closePool,
  continueTask,
  createTask,
  createTaskRepos,
  getPendingContinuationNote,
  getPool,
  getTaskStatusById,
  listProjectRepos,
  setTaskWorkBranch,
  syncMainProjectRepo,
  updateTaskRepoBranchAndResetPr
} from "@claude-center/db";

const PROJECT_ID = "00000000-0000-0000-0000-000000000020";
const WORKER_ID = "00000000-0000-0000-0000-000000000021";
const SESSION_ID_SUCCESS = "11111111-1111-1111-1111-111111111111";
const SESSION_ID_MERGED = "22222222-2222-2222-2222-222222222222";
const OLD_PR_URL = "https://github.com/example/repo/pull/42";

async function seedProjectAndWorker(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (id, name, repo_url, default_branch)
     VALUES ($1, 'Continuation Smoke Project', 'https://example.invalid/cont.git', 'main')`,
    [PROJECT_ID]
  );
  // 多仓任务支持：projects 表外再镜像一行 project_repos role='main'（createProject 的内置流程）。
  await syncMainProjectRepo(pool, PROJECT_ID);
  // worker 必须存在（claimed_by 是 FK；continueTask 不强校验，但 claimNextContinuationTask 用 claimed_by 过滤）
  await pool.query(
    `INSERT INTO workers (id, name, host_name, app_version)
     VALUES ($1, 'cont-worker', 'localhost', '0.0.0-smoke')`,
    [WORKER_ID]
  );
}

async function mkTask(title: string, workBranch: string): Promise<string> {
  const pool = getPool();
  const task = await createTask(pool, {
    projectId: PROJECT_ID,
    title,
    description: "continuation-smoke",
    baseBranch: "main",
    workBranch,
    targetBranch: "main",
    submitMode: "pr",
    autoMergePr: false,
    autoReply: false,
    autoDecisionHints: "",
    model: "default",
    dynamicWorkflow: false,
    scheduledAt: null
  });
  // 主仓 task_repos 行（API 端在 POST 路由里手工建；这里复刻最小可用形态）
  const repos = await listProjectRepos(pool, PROJECT_ID);
  const mainRepo = repos.find((r) => r.role === "main");
  if (!mainRepo) throw new Error(`mkTask: project ${PROJECT_ID} 缺主仓 project_repos 行`);
  await createTaskRepos(pool, task.id, [
    {
      projectRepoId: mainRepo.id,
      role: "main",
      relativePath: ".",
      baseBranch: "main",
      workBranch,
      targetBranch: "main",
      subStatus: "pending"
    }
  ]);
  return task.id;
}

// 模拟任务已被 worker 完成：状态翻 success/merged + 关联 worker + 记 session/pr_url 与时间戳。
async function forceCompleted(
  id: string,
  status: "success" | "merged",
  sessionId: string,
  prUrl: string | null
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE tasks
        SET status = $2,
            claimed_by = $3,
            claimed_at = now(),
            started_at = now(),
            finished_at = now(),
            claude_session_id = $4,
            pr_url = $5,
            updated_at = now()
      WHERE id = $1`,
    [id, status, WORKER_ID, sessionId, prUrl]
  );
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function countEvents(taskId: string, type: string): Promise<number> {
  const pool = getPool();
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM task_events WHERE task_id = $1 AND event_type = $2`,
    [taskId, type]
  );
  return Number(r.rows[0]?.n ?? "0");
}

async function lastUserComment(taskId: string): Promise<string | null> {
  const pool = getPool();
  const r = await pool.query<{ body: string }>(
    `SELECT body FROM task_comments WHERE task_id = $1 AND author = 'user' ORDER BY created_at DESC LIMIT 1`,
    [taskId]
  );
  return r.rows[0]?.body ?? null;
}

async function getTaskRow(taskId: string): Promise<{
  status: string;
  continuation_count: number;
  continuation_requested_at: string | null;
  work_branch: string;
  pr_url: string | null;
  claimed_by: string | null;
  finished_at: string | null;
  claude_session_id: string | null;
}> {
  const pool = getPool();
  const r = await pool.query(
    `SELECT status, continuation_count, continuation_requested_at, work_branch, pr_url,
            claimed_by::text AS claimed_by, finished_at, claude_session_id
       FROM tasks WHERE id = $1`,
    [taskId]
  );
  return r.rows[0];
}

async function main(): Promise<void> {
  await seedProjectAndWorker();
  const pool = getPool();

  // ============================================================
  // case 1: success 任务续跑
  // ============================================================
  const successId = await mkTask("continue-success", "feature/cont-success");
  await forceCompleted(successId, "success", SESSION_ID_SUCCESS, OLD_PR_URL);

  const noteA = "登录按钮点了没反应，请加上事件绑定";
  const continued = await continueTask(pool, successId, noteA);
  if (!continued) throw new Error("continueTask(success): 返回 null（未命中 success/merged 守卫）");
  assertEq(continued.status, "claimed", "continue(success).status");
  assertEq(continued.continuation_count, 1, "continue(success).count");
  if (!continued.continuation_requested_at) throw new Error("continue(success): continuation_requested_at 未落");
  assertEq(continued.finished_at, null, "continue(success).finished_at 清空");
  assertEq(continued.claude_session_id, SESSION_ID_SUCCESS, "continue(success).claude_session_id 保留");
  assertEq(continued.pr_url, OLD_PR_URL, "continue(success).pr_url 保留");
  assertEq(continued.claimed_by, WORKER_ID, "continue(success).claimed_by 保留");
  // user 评论 + 事件
  assertEq(await lastUserComment(successId), noteA, "continue(success).user_comment");
  assertEq(await countEvents(successId, "continuation_requested"), 1, "continue(success).event_count");
  console.log("✓ continueTask(success) → claimed + count=1 + 评论与事件落库");

  // claimNextContinuationTask 认领
  const claimedA = await claimNextContinuationTask(pool, WORKER_ID);
  if (!claimedA) throw new Error("claimNextContinuationTask(success): 未认领");
  assertEq(claimedA.id, successId, "claim(success).id");
  assertEq(claimedA.status, "running", "claim(success).status 翻 running");
  assertEq(claimedA.continuation_requested_at, null, "claim(success).continuation_requested_at 已清");
  assertEq(claimedA.continuation_count, 1, "claim(success).count 保留");
  assertEq(await countEvents(successId, "continuation_started"), 1, "claim(success).event_count");
  console.log("✓ claimNextContinuationTask(success) → running + continuation_started 事件");

  // 续跑反馈正文（worker prompt 首帧拼接）
  const note = await getPendingContinuationNote(pool, successId);
  assertEq(note?.trim(), noteA, "getPendingContinuationNote(success).text");
  console.log("✓ getPendingContinuationNote(success) → 拼到本轮 user 评论");

  // ============================================================
  // case 2: merged 任务续跑（case B：切 -cont-1 新分支）
  // ============================================================
  const mergedId = await mkTask("continue-merged", "feature/cont-merged");
  await forceCompleted(mergedId, "merged", SESSION_ID_MERGED, OLD_PR_URL);

  // 模拟主仓的 task_repos main 行（createTask 已自动建主仓行）
  const noteB = "PR 已合，但还差测试覆盖，再补一轮单测";
  const continuedB = await continueTask(pool, mergedId, noteB);
  if (!continuedB) throw new Error("continueTask(merged): 返回 null");
  assertEq(continuedB.status, "claimed", "continue(merged).status");
  assertEq(continuedB.continuation_count, 1, "continue(merged).count");
  assertEq(continuedB.work_branch, "feature/cont-merged", "continue(merged).work_branch 保留原始");
  assertEq(continuedB.pr_url, OLD_PR_URL, "continue(merged).pr_url 保留（worker 检测后清掉）");

  // worker 端模拟 case B 路径：updateTaskRepoBranchAndResetPr + setTaskWorkBranch
  const newBranch = `${continuedB.work_branch}-cont-${continuedB.continuation_count}`;
  const repoRow = await pool.query<{ id: string }>(
    `SELECT id FROM task_repos WHERE task_id = $1 AND role = 'main' LIMIT 1`,
    [mergedId]
  );
  if (!repoRow.rows[0]) throw new Error("merged: 主仓 task_repos 行未自动建（看 createTask）");
  await updateTaskRepoBranchAndResetPr(pool, repoRow.rows[0].id, newBranch);
  await setTaskWorkBranch(pool, mergedId, WORKER_ID, newBranch);
  const repoAfter = await pool.query<{ work_branch: string; pr_url: string | null; sub_status: string }>(
    `SELECT work_branch, pr_url, sub_status FROM task_repos WHERE id = $1`,
    [repoRow.rows[0].id]
  );
  assertEq(repoAfter.rows[0].work_branch, newBranch, "case B: task_repos.work_branch 切到 -cont-1");
  assertEq(repoAfter.rows[0].pr_url, null, "case B: task_repos.pr_url 已清");
  assertEq(repoAfter.rows[0].sub_status, "pending", "case B: task_repos.sub_status 重置 pending");
  const taskAfter = await getTaskRow(mergedId);
  assertEq(taskAfter.work_branch, newBranch, "case B: tasks.work_branch 镜像");
  console.log(`✓ continueTask(merged) + worker 模拟 case B：分支 -cont-1=${newBranch} 已切，PR 已清`);

  // ============================================================
  // case 3: 守卫——非 success/merged 不可发起续跑
  // ============================================================
  const draftId = await mkTask("guard-draft", "feature/guard-draft");
  const draftResult = await continueTask(pool, draftId, "should fail");
  if (draftResult !== null) throw new Error("guard: draft 任务不应可续跑");

  const runningId = await mkTask("guard-running", "feature/guard-running");
  await pool.query(`UPDATE tasks SET status = 'running' WHERE id = $1`, [runningId]);
  const runningResult = await continueTask(pool, runningId, "should fail");
  if (runningResult !== null) throw new Error("guard: running 任务不应可续跑");

  const failedId = await mkTask("guard-failed", "feature/guard-failed");
  await pool.query(`UPDATE tasks SET status = 'failed' WHERE id = $1`, [failedId]);
  const failedResult = await continueTask(pool, failedId, "should fail");
  if (failedResult !== null) throw new Error("guard: failed 任务不应可续跑（应走 requestTaskRetry）");
  console.log("✓ guard: draft / running / failed 任务发起续跑均返回 null（API 端将翻 409）");

  // ============================================================
  // case 4: 空 note 抛错（API 端先校验，DB 层兜底）
  // ============================================================
  const emptyId = await mkTask("guard-empty-note", "feature/guard-empty");
  await forceCompleted(emptyId, "success", SESSION_ID_SUCCESS, null);
  let threw = false;
  try {
    await continueTask(pool, emptyId, "   ");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("guard: 空 note 应抛错");
  console.log("✓ guard: 空 continuation_note 抛错");

  // ============================================================
  // case 5: 多轮续跑——continuation_count 单调递增
  // ============================================================
  // 先把 mergedId 也认领掉，避免它的 continuation_requested_at 抢占 worker 队列（按时间戳 ASC 排序）
  const claimMerged = await claimNextContinuationTask(pool, WORKER_ID);
  if (!claimMerged || claimMerged.id !== mergedId) throw new Error("应先认领 mergedId 续跑（FIFO）");
  // 让 successId 任务从 running 翻回 success（模拟 worker 完成本轮）再发起第二次续跑
  await pool.query(
    `UPDATE tasks SET status = 'success', finished_at = now(), updated_at = now() WHERE id = $1`,
    [successId]
  );
  const second = await continueTask(pool, successId, "还有一个细节没改");
  if (!second) throw new Error("第二轮续跑: 返回 null");
  assertEq(second.continuation_count, 2, "第二轮 count=2");
  const claim2 = await claimNextContinuationTask(pool, WORKER_ID);
  if (!claim2 || claim2.id !== successId) throw new Error(`第二轮应认领 successId，实际 ${claim2?.id}`);
  assertEq(await countEvents(successId, "continuation_requested"), 2, "第二轮 continuation_requested 累计=2");
  assertEq(await countEvents(successId, "continuation_started"), 2, "第二轮 continuation_started 累计=2");
  // getPendingContinuationNote 只取最新一轮的 user 评论（按最近 continuation_requested 锚点）
  const note2 = await getPendingContinuationNote(pool, successId);
  assertEq(note2?.trim(), "还有一个细节没改", "第二轮 note 仅含本轮反馈，不含上一轮");
  console.log("✓ 多轮续跑: continuation_count 单调递增，note 按本轮锚点取");

  // ============================================================
  // case 6: getTaskStatusById（gcWorktrees TOCTOU 二次校验用）
  // ============================================================
  const exists = await getTaskStatusById(pool, successId);
  assertEq(exists, "running", "getTaskStatusById(running)"); // 上一步 claim 后仍是 running
  const bogus = await getTaskStatusById(pool, "00000000-0000-0000-0000-deadbeefcafe");
  assertEq(bogus, null, "getTaskStatusById(不存在)");
  console.log("✓ getTaskStatusById: 现状状态 / 不存在均按预期");

  // ============================================================
  // case 7: GC TOCTOU 模拟——keep 集合外的 task，二次校验现状已翻 claimed → 应跳过删除
  // ============================================================
  const toctouId = await mkTask("toctou-case", "feature/toctou");
  await forceCompleted(toctouId, "success", SESSION_ID_SUCCESS, null);
  // 模拟 gc 起点：keep 集合还没包含 toctouId（典型 race：keep 抓取 → continueTask 翻 claimed → gc 准备删）。
  // 这里调 continueTask 让任务翻 claimed，再调 getTaskStatusById 模拟二次校验。
  await continueTask(pool, toctouId, "TOCTOU 测试");
  const recheck = await getTaskStatusById(pool, toctouId);
  if (recheck !== "claimed") throw new Error(`toctou: 期望 claimed, 实际 ${recheck}`);
  // 业务层 KEEP_AFTER_RECHECK 包含 claimed → 应该跳过删除（这里仅断言现状，删除逻辑由 worktree.ts 内联完成）
  const KEEP_AFTER_RECHECK = new Set(["claimed", "running", "waiting", "success", "merged", "failed", "cancelled"]);
  if (!KEEP_AFTER_RECHECK.has(recheck!)) {
    throw new Error(`toctou: gcWorktrees 应保留 claimed worktree, 实际现状=${recheck}`);
  }
  console.log("✓ TOCTOU: success → continueTask → claimed; 二次校验命中 KEEP_AFTER_RECHECK → 跳过删除");

  console.log("\nall continuation behaviors verified");
}

try {
  await main();
} finally {
  await closePool();
}
