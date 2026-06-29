// 行为冒烟：多轮任务在 tasks.result.rounds[] 累计每一轮的产出与 PR URL
// docs/spec/multi-round-task-history.md
//
// 关键断言：
//   - 首轮 markTaskSuccess → rounds.length=1, rounds[0].round=0, rounds[0].output==首轮 output, rounds[0].prUrls 累计本轮 PR
//   - 续跑 + 第二轮 markTaskSuccess → rounds.length=2, rounds[1].round=1, rounds[1].output==第二轮 output
//   - 首轮内容在第二轮后仍然完整保留（不被覆盖）
//   - 旧字段 claudeResult 仍同步指向最新一轮（向后兼容 fallback）
//
// 由 run-smoke-against-ephemeral.mjs 触发：
//   node scripts/run-smoke-against-ephemeral.mjs scripts/smoke-multi-round-result.mts
import {
  closePool,
  continueTask,
  createTask,
  getPool,
  markTaskSuccess,
  syncMainProjectRepo
} from "@claude-center/db";

const PROJECT_ID = "00000000-0000-0000-0000-0000000000a0";
const WORKER_ID = "00000000-0000-0000-0000-0000000000a1";

async function seedProjectAndWorker(): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (id, name, repo_url, default_branch)
     VALUES ($1, 'Multi-Round Smoke Project', 'https://example.invalid/multi-round.git', 'main')`,
    [PROJECT_ID]
  );
  await syncMainProjectRepo(pool, PROJECT_ID);
  await pool.query(
    `INSERT INTO workers (id, name, host_name, app_version)
     VALUES ($1, 'multi-round-worker', 'localhost', '0.0.0-smoke')`,
    [WORKER_ID]
  );
}

async function mkTask(): Promise<string> {
  const pool = getPool();
  const task = await createTask(pool, {
    projectId: PROJECT_ID,
    title: "multi-round-result-smoke",
    description: "multi-round-smoke",
    baseBranch: "main",
    workBranch: "feature/multi-round",
    targetBranch: "main",
    submitMode: "pr",
    autoMergePr: false,
    autoReply: false,
    autoDecisionHints: "",
    model: "default",
    dynamicWorkflow: false,
    scheduledAt: null
  });
  // 模拟 worker 已 claim：claimed_by 必须等于 markTaskSuccess 的 workerId（UPDATE 条件）
  await pool.query(
    `UPDATE tasks SET status='running', claimed_by=$2, claimed_at=now(), started_at=now(), updated_at=now()
      WHERE id=$1`,
    [task.id, WORKER_ID]
  );
  return task.id;
}

async function readResult(taskId: string): Promise<{ result: Record<string, unknown>; continuation_count: number }> {
  const pool = getPool();
  const r = await pool.query<{ result: Record<string, unknown>; continuation_count: number }>(
    `SELECT result, continuation_count FROM tasks WHERE id=$1`,
    [taskId]
  );
  if (!r.rows[0]) throw new Error(`task ${taskId} not found`);
  return r.rows[0];
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  await seedProjectAndWorker();
  const pool = getPool();
  const taskId = await mkTask();

  // ============================================================
  // 第 0 轮（首轮）：markTaskSuccess 写入 rounds[0]
  // ============================================================
  const firstOutput = "## 首轮总结\n- 加了登录按钮事件绑定\n- 单测覆盖通过";
  const firstPrUrl = "https://github.com/example/repo/pull/100";
  await markTaskSuccess(
    pool,
    taskId,
    WORKER_ID,
    { workdir: "/wt", submitMode: "pr", claudeResult: firstOutput, multiRepo: [] },
    firstPrUrl,
    { output: firstOutput, prUrls: [firstPrUrl], submitMode: "pr" }
  );

  const afterFirst = await readResult(taskId);
  const rounds1 = (afterFirst.result as { rounds?: unknown }).rounds;
  if (!Array.isArray(rounds1)) throw new Error("首轮后 result.rounds 不是数组");
  assertEq(rounds1.length, 1, "首轮后 rounds.length");
  const r0 = rounds1[0] as Record<string, unknown>;
  assertEq(r0.round as number, 0, "rounds[0].round=0");
  assertEq(r0.output as string, firstOutput, "rounds[0].output==首轮 output");
  assertEq(r0.submitMode as string, "pr", "rounds[0].submitMode='pr'");
  const r0PrUrls = r0.prUrls as string[];
  if (!Array.isArray(r0PrUrls) || r0PrUrls.length !== 1 || r0PrUrls[0] !== firstPrUrl) {
    throw new Error(`rounds[0].prUrls 期望 ['${firstPrUrl}'], 实际 ${JSON.stringify(r0PrUrls)}`);
  }
  if (typeof r0.completedAt !== "string" || !r0.completedAt) {
    throw new Error("rounds[0].completedAt 缺失");
  }
  // 向后兼容：claudeResult 仍同步成最新一轮
  assertEq((afterFirst.result as { claudeResult?: string }).claudeResult, firstOutput, "claudeResult 同步最新轮");
  console.log("✓ 首轮 markTaskSuccess → rounds[0] 落库（round=0/output/prUrls/completedAt/submitMode 齐全）");

  // ============================================================
  // 续跑：continueTask 翻 claimed + continuation_count++，再 claim → running
  // ============================================================
  // markTaskSuccess 已把 status 翻 success；continueTask 守卫接受 success → claimed
  const continued = await continueTask(pool, taskId, "登录按钮还差错误提示");
  if (!continued) throw new Error("continueTask 返回 null（应能续跑 success 任务）");
  assertEq(continued.continuation_count, 1, "续跑后 continuation_count=1");
  // 模拟 worker claim 续跑任务 → status=running, claimed_by 不变
  await pool.query(
    `UPDATE tasks SET status='running', continuation_requested_at=NULL, updated_at=now() WHERE id=$1`,
    [taskId]
  );

  // ============================================================
  // 第 1 轮（续跑后）：markTaskSuccess 写入 rounds[1]
  // ============================================================
  const secondOutput = "## 续跑总结\n- 加了错误提示 toast\n- 现有用例已覆盖错误路径";
  const secondPrUrl = "https://github.com/example/repo/pull/101";
  await markTaskSuccess(
    pool,
    taskId,
    WORKER_ID,
    { workdir: "/wt", submitMode: "pr", claudeResult: secondOutput, multiRepo: [] },
    secondPrUrl,
    { output: secondOutput, prUrls: [secondPrUrl], submitMode: "pr" }
  );

  const afterSecond = await readResult(taskId);
  const rounds2 = (afterSecond.result as { rounds?: unknown }).rounds as Record<string, unknown>[];
  if (!Array.isArray(rounds2)) throw new Error("第二轮后 result.rounds 不是数组");
  assertEq(rounds2.length, 2, "第二轮后 rounds.length=2");
  // 首轮条目应保留不变
  assertEq(rounds2[0]!.round as number, 0, "rounds[0].round 仍是 0");
  assertEq(rounds2[0]!.output as string, firstOutput, "rounds[0].output 仍是首轮内容（不被覆盖）");
  assertEq((rounds2[0]!.prUrls as string[])[0], firstPrUrl, "rounds[0].prUrls 仍是首轮 PR");
  // 第二轮条目
  assertEq(rounds2[1]!.round as number, 1, "rounds[1].round=1（== continuation_count at success）");
  assertEq(rounds2[1]!.output as string, secondOutput, "rounds[1].output==第二轮 output");
  assertEq((rounds2[1]!.prUrls as string[])[0], secondPrUrl, "rounds[1].prUrls=[第二轮 PR]");
  // claudeResult 同步最新一轮
  assertEq(
    (afterSecond.result as { claudeResult?: string }).claudeResult,
    secondOutput,
    "claudeResult 同步到第二轮"
  );
  console.log("✓ 第二轮 markTaskSuccess → rounds[1] append；首轮内容完整保留");

  // ============================================================
  // 三轮验证：再续一轮，断言 rounds.length=3 + 严格累计
  // ============================================================
  await pool.query(`UPDATE tasks SET status='success' WHERE id=$1`, [taskId]);
  const continued2 = await continueTask(pool, taskId, "再来一轮微调");
  if (!continued2) throw new Error("第三轮 continueTask 返回 null");
  await pool.query(
    `UPDATE tasks SET status='running', continuation_requested_at=NULL WHERE id=$1`,
    [taskId]
  );
  const thirdOutput = "微调完成";
  const thirdPrUrls = [
    "https://github.com/example/repo/pull/102",
    "https://github.com/example/sub-repo/pull/103"
  ];
  await markTaskSuccess(
    pool,
    taskId,
    WORKER_ID,
    { workdir: "/wt", submitMode: "pr", claudeResult: thirdOutput, multiRepo: [] },
    thirdPrUrls[0]!,
    { output: thirdOutput, prUrls: thirdPrUrls, submitMode: "pr" }
  );
  const afterThird = await readResult(taskId);
  const rounds3 = (afterThird.result as { rounds: Record<string, unknown>[] }).rounds;
  assertEq(rounds3.length, 3, "第三轮后 rounds.length=3");
  assertEq(rounds3[2]!.round as number, 2, "rounds[2].round=2");
  assertEq((rounds3[2]!.prUrls as string[]).length, 2, "rounds[2].prUrls 含主仓+子仓两条");
  // 首轮 / 第二轮仍按累计形态保留
  assertEq(rounds3[0]!.output as string, firstOutput, "三轮后 rounds[0].output 仍是首轮内容");
  assertEq(rounds3[1]!.output as string, secondOutput, "三轮后 rounds[1].output 仍是第二轮内容");
  console.log("✓ 第三轮 markTaskSuccess → rounds[2] append（含多仓 prUrls）；前两轮完整保留");

  // ============================================================
  // push 模式：submitMode='push' + prUrls=[]
  // ============================================================
  const pushTaskId = await mkTask();
  const pushOutput = "push 模式无 PR";
  await markTaskSuccess(
    pool,
    pushTaskId,
    WORKER_ID,
    { workdir: "/wt", submitMode: "push", claudeResult: pushOutput, multiRepo: [] },
    null,
    { output: pushOutput, prUrls: [], submitMode: "push" }
  );
  const afterPush = await readResult(pushTaskId);
  const pushRounds = (afterPush.result as { rounds: Record<string, unknown>[] }).rounds;
  assertEq(pushRounds.length, 1, "push 任务 rounds.length=1");
  assertEq(pushRounds[0]!.submitMode as string, "push", "push 任务 submitMode='push'");
  assertEq((pushRounds[0]!.prUrls as string[]).length, 0, "push 任务 prUrls=[]");
  console.log("✓ push 模式：submitMode='push' + prUrls=[]");

  console.log("\nall multi-round result accumulation behaviors verified");
}

try {
  await main();
} finally {
  await closePool();
}
