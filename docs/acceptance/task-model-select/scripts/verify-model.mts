// 端到端验证任务级 model：列/默认值/CHECK 约束 + 真实 createTask 落库读回。
// 全程在事务内并最终 ROLLBACK，不污染共享 dev 库。
import { closePool, createTask, getPool, loadRootEnv } from "@claude-center/db";

loadRootEnv(process.cwd());

async function main() {
  const pool = getPool();
  const client = await pool.connect();
  let pass = true;
  try {
    await client.query("BEGIN");

    // 1) 列存在 + 默认值
    const col = await client.query(
      `SELECT data_type, column_default
         FROM information_schema.columns
        WHERE table_name = 'tasks' AND column_name = 'model'`
    );
    console.log("[1] model column:", JSON.stringify(col.rows[0] ?? null));
    if (!col.rows[0] || !String(col.rows[0].column_default).includes("default")) pass = false;

    const proj = await client.query(`SELECT id FROM projects LIMIT 1`);
    if (!proj.rows[0]) {
      console.log("[!] no project in dev db — skip insert path");
    } else {
      const projectId = proj.rows[0].id as string;

      // 2) 真实 createTask 走合法 model 落库 + 读回
      const task = await createTask(client, {
        projectId,
        taskType: "work",
        title: "model-verify",
        description: "verify task-level model",
        baseBranch: "main",
        workBranch: `cc/model-verify-${col.rows.length}`,
        targetBranch: "main",
        submitMode: "pr",
        model: "opus"
      });
      console.log("[2] createTask model =", task.model, "(expect opus)");
      if (task.model !== "opus") pass = false;

      // 3) 非法 model 被 CHECK 拒绝
      let rejected = false;
      try {
        await client.query(
          `INSERT INTO tasks (project_id, task_type, title, description, base_branch, work_branch, target_branch, submit_mode, model, status)
           VALUES ($1,'work','x','x','main','cc/illegal','main','pr','gpt5','draft')`,
          [projectId]
        );
      } catch (e) {
        rejected = true;
        console.log("[3] illegal model rejected:", (e as Error).message.split("\n")[0]);
      }
      if (!rejected) pass = false;
    }

    await client.query("ROLLBACK");
    console.log("[*] rolled back — dev db unchanged");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // 事务可能已因前一个错误 abort
    }
    console.error("ERROR:", e);
    pass = false;
  } finally {
    client.release();
    await closePool();
  }
  console.log(pass ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(pass ? 0 : 1);
}

void main();
