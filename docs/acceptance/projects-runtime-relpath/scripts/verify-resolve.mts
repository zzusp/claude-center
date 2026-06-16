// 验证 worker 端 resolveSubRepoRelativePath + updateTaskRepoRelativePath 链路。
// 不真实起 Electron worker；只验关键算法 + DB 落地。
//
// 三场景：
//   A. 复用既有 clone：mainLocal 下手动 `git init` 一个 sub repo + 设 remote.origin.url 等价于 inputRepoUrl
//      → resolve 返回该目录名
//   B. basename 兜底：mainLocal 干净 → resolve 返回 basename(repoUrl)（路径不存在，由 ensureSubRepoCloned 之后建）
//   C. 冲突报错：basename 路径被无关内容（无 .git）占用 → resolve 抛错
//   D. UPDATE 链路：seed 一个 task_repos 行（relative_path='*-xxx'）→ updateTaskRepoRelativePath → 断言 DB 值
//
// 跑法：起 ephemeral DB 后注入 DATABASE_URL，然后 `npx tsx verify-resolve.mts`。
// 推荐通过外层 `node scripts/ephemeral-db.mjs --runScript <此脚本绝对路径>`（如该 hook 存在）；
// 没有时手动 export DATABASE_URL 后 tsx。

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

// 走构建产物，避免 tsx 解析 .js 后缀的 ESM import。
import {
  resolveSubRepoRelativePath
} from "../../../../apps/worker/dist/worktree.js";

let pass = 0;
let fail = 0;
function expect(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q", { cwd: dir });
}

function gitSetRemote(dir: string, url: string): void {
  execSync(`git remote add origin "${url}"`, { cwd: dir });
}

async function scenarioA(): Promise<void> {
  console.log("\n[A] 复用既有 clone（remote.origin.url 等价匹配）");
  const tmp = mkdtempSync(path.join(tmpdir(), "ccvr-A-"));
  try {
    const sub = path.join(tmp, "vendor", "renamed-widgets");
    gitInit(sub);
    gitSetRemote(sub, "git@github.com:acme/widgets-lib.git");
    // 输入 https + 去 .git 形式，归一化后应等价
    const got = await resolveSubRepoRelativePath(tmp, "https://github.com/acme/widgets-lib");
    expect("命中改名后的子仓", got === "vendor/renamed-widgets", `got=${got}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function scenarioB(): Promise<void> {
  console.log("\n[B] basename 兜底（mainLocal 干净）");
  const tmp = mkdtempSync(path.join(tmpdir(), "ccvr-B-"));
  try {
    gitInit(tmp); // mainLocal 自己是 git 仓库
    const got = await resolveSubRepoRelativePath(tmp, "https://github.com/acme/widgets-lib.git");
    expect("basename 派生", got === "widgets-lib", `got=${got}`);
    expect("派生路径不实际创建", !existsSync(path.join(tmp, "widgets-lib")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function scenarioC(): Promise<void> {
  console.log("\n[C] basename 冲突（路径被无关内容占用）");
  const tmp = mkdtempSync(path.join(tmpdir(), "ccvr-C-"));
  try {
    gitInit(tmp);
    // basename 派生为 widgets-lib，但该路径下我手动放一个无关文件夹（无 .git）
    const taken = path.join(tmp, "widgets-lib");
    mkdirSync(taken);
    writeFileSync(path.join(taken, "README.md"), "not a git repo");
    let thrown: Error | null = null;
    try {
      await resolveSubRepoRelativePath(tmp, "https://github.com/acme/widgets-lib.git");
    } catch (err) {
      thrown = err as Error;
    }
    expect("应抛错", thrown !== null, "未抛错");
    expect(
      "错误消息含路径",
      thrown != null && /widgets-lib/.test(thrown.message),
      thrown?.message
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function scenarioD(): Promise<void> {
  console.log("\n[D] DB UPDATE 链路");
  if (!process.env.DATABASE_URL) {
    console.log("  (跳过：DATABASE_URL 未设置)");
    return;
  }
  const dbMod = await import("../../../../packages/db/dist/index.js") as typeof import("@claude-center/db");
  const pool = dbMod.getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // seed：project（无 created_by） / project_repos main+sub / task / task_repos 主仓 + 子仓占位
    const p = await client.query<{ id: string }>(
      `INSERT INTO projects (name, repo_url, default_branch, description)
       VALUES ('proj-vr', 'https://github.com/acme/main.git', 'main', 'test')
       RETURNING id`
    );
    const projectId = p.rows[0]!.id;
    await dbMod.syncMainProjectRepo(client, projectId);
    const sub = await client.query<{ id: string }>(
      `INSERT INTO project_repos (project_id, role, repo_url, default_branch, name, description, position)
       VALUES ($1, 'sub', 'https://github.com/acme/sublib.git', 'main', 'sublib', 'd', 1)
       RETURNING id`,
      [projectId]
    );
    const subRepoId = sub.rows[0]!.id;
    const t = await client.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, description, base_branch, work_branch, target_branch, submit_mode, status)
       VALUES ($1, 't', 'p', 'main', 'work-x', 'main', 'pr', 'pending')
       RETURNING id`,
      [projectId]
    );
    const taskId = t.rows[0]!.id;
    await client.query(
      `INSERT INTO task_repos (task_id, project_repo_id, role, relative_path, base_branch, work_branch, target_branch)
       SELECT $1, id, 'main', '.', 'main', 'work-x', 'main' FROM project_repos WHERE project_id=$2 AND role='main'`,
      [taskId, projectId]
    );
    const subTrPath = `*-${subRepoId}`;
    const subTr = await client.query<{ id: string }>(
      `INSERT INTO task_repos (task_id, project_repo_id, role, relative_path, base_branch, work_branch, target_branch)
       VALUES ($1, $2, 'sub', $3, 'main', 'work-x-sublib', 'main') RETURNING id`,
      [taskId, subRepoId, subTrPath]
    );
    expect("子仓行入库占位", subTrPath.startsWith("*-"));

    await dbMod.updateTaskRepoRelativePath(client, subTr.rows[0]!.id, "vendor/sublib");
    const after = await client.query<{ relative_path: string }>(
      `SELECT relative_path FROM task_repos WHERE id = $1`,
      [subTr.rows[0]!.id]
    );
    expect(
      "UPDATE 后 relative_path 改写",
      after.rows[0]!.relative_path === "vendor/sublib",
      after.rows[0]!.relative_path
    );
    await client.query("ROLLBACK"); // 不污染测试库
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
