// 真·端到端：用真实产品代码 finalizeTaskMultiRepo（apps/worker/dist/executor.js）跑 PR 收尾流程，
// 验证三件事——① PR body 渲染 Markdown（不再代码块）② Test Plan 门禁（全通过→合，未通过/未测试→拦）
// ③ 不可合并 / 门禁拦下都发 task_review_required 通知。
// 零污染：临时 PG 库 + 临时本地 git 仓（bare origin + clone + worktree）；gh 用 node.exe + --require 假冒。
// 走的产品路径：finalize → git commit/push origin（真）→ gh pr list/create/view/merge（假）
//   → prBody → parseTestPlan 门禁 → tryAutoMergeAllOrNone / blockAutoMergeForTestPlan → 事件 + 通知落库。
// 用法：node docs/acceptance/pr-testplan-gate/scripts/e2e-finalize-gate.mjs
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");

// 加载最近的 .env（向上找，不覆盖已有环境变量）。
{
  let dir = root;
  for (let i = 0; i < 8; i += 1) {
    const c = path.join(dir, ".env");
    if (existsSync(c)) { process.loadEnvFile(c); break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) throw new Error("DATABASE_URL is required（先配 .env）");

const url = new URL(baseUrl);
const dbName = `cc_finalize_e2e_${Date.now()}`;
const adminUrl = new URL(url); adminUrl.pathname = "/postgres";
const targetUrl = new URL(url); targetUrl.pathname = `/${dbName}`;
const migrationsDir = path.join(root, "packages", "db", "migrations");

const pg = (await import("pg")).default;
async function withClient(connUrl, fn) {
  const client = new pg.Client({ connectionString: connUrl.toString() });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}
function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}

let failures = 0;
const assert = (cond, msg) => { if (cond) { console.log(`  ✓ ${msg}`); } else { failures++; console.log(`  ✗ ${msg}`); } };

let created = false, tmpRoot = null, pool = null;
try {
  // ---- 本地 git：bare origin + clone（checkout 作 localPath） ----
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "cc-finalize-e2e-"));
  const seed = path.join(tmpRoot, "seed");
  const bare = path.join(tmpRoot, "origin.git");
  const checkout = path.join(tmpRoot, "checkout");
  git(["init", "-b", "main", seed]);
  git(["config", "user.email", "e2e@example.com"], seed);
  git(["config", "user.name", "e2e"], seed);
  await writeFile(path.join(seed, "README.md"), "# seed\n", "utf8");
  git(["add", "-A"], seed); git(["commit", "-m", "init"], seed);
  git(["init", "--bare", "-b", "main", bare]);
  git(["remote", "add", "origin", bare], seed);
  git(["push", "origin", "main"], seed);
  git(["clone", bare, checkout]);
  git(["config", "user.email", "worker@example.com"], checkout);
  git(["config", "user.name", "worker"], checkout);
  git(["config", "commit.gpgsign", "false"], checkout);
  // 假 gh hook 拷进临时目录（路径无空格，--require 友好）
  const hookSrc = path.join(here, "fake-gh-hook.cjs");
  const hook = path.join(tmpRoot, "fake-gh-hook.cjs");
  copyFileSync(hookSrc, hook);
  const hookOpt = hook.replace(/\\/g, "/"); // NODE_OPTIONS=--require 用正斜杠路径，避免反斜杠转义坑
  console.log(`✓ 本地仓 + hook 就绪：${tmpRoot}`);

  // ---- 临时 PG 库 + 全量迁移 ----
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${dbName}"`));
  created = true;
  await withClient(targetUrl, async (c) => {
    await c.query("BEGIN");
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) await c.query(await readFile(path.join(migrationsDir, f), "utf8"));
    await c.query("COMMIT");
  });
  console.log(`✓ 临时库迁移完成：${dbName}`);

  // ---- db 指向临时库，import 产品代码 ----
  process.env.DATABASE_URL = targetUrl.toString();
  const db = await import("@claude-center/db");
  db.setDatabaseUrl(targetUrl.toString());
  pool = db.getPool();
  const { finalizeTaskMultiRepo } = await import(pathToFileURL(path.join(root, "apps", "worker", "dist", "executor.js")).href);

  // ---- 公共种子：worker + project + link ----
  const workerId = randomUUID();
  await pool.query(`INSERT INTO workers (id, name, host_name) VALUES ($1,'e2e-worker','e2e-host')`, [workerId]);
  const project = await db.createProject(pool, { name: `e2e-${Date.now()}`, repoUrl: bare, defaultBranch: "main", description: "finalize e2e" });
  await db.upsertWorkerProjectLink(pool, { workerId, projectName: project.name, repoUrl: bare, localPath: checkout });
  const projectRepoId = (await pool.query(`SELECT id FROM project_repos WHERE project_id=$1 AND role='main'`, [project.id])).rows[0].id;

  const config = {
    workerId, workerName: "e2e", hostName: "e2e", appVersion: "0.1.0",
    databaseUrl: targetUrl.toString(), projects: [], pollIntervalMs: 10000, heartbeatIntervalMs: 15000,
    claudeCommand: "claude", claudePreCommand: "", terminalCommand: "",
    ghCommand: process.execPath, // node.exe 假冒 gh（配合 NODE_OPTIONS=--require hook）
    permissionMode: "bypassPermissions",
    claudeSettingsPath: path.join(root, "apps", "worker", "config", "claude-settings.json"),
    claudeRulesPath: path.join(root, "apps", "worker", "prompts", "center-rules.md"),
    dataDir: path.join(tmpRoot, "data"), maxParallel: 1, allowRemoteControl: false,
    usageProxy: null, infoIntervalMs: 60000, usageIntervalMs: 300000, relayUrl: "", relayPublishToken: "", relayWorkerToken: ""
  };

  const PASS_PLAN = ["## Summary", "做了改动。", "", "## Changes", "- s.txt:1 — 加了一行", "", "## Test Plan", "- [x] typecheck 通过", "- [x] build 通过"].join("\n");
  const UNTESTED_PLAN = ["## Summary", "改了一半。", "", "## Changes", "- s.txt:1 — 加了一行", "", "## Test Plan", "- [x] typecheck 通过", "- [ ] e2e 未跑"].join("\n");

  // 单场景执行器：seed 任务 + worktree + 改动 → finalize → 返回事件/通知/gh 调用记录。
  async function runScenario({ label, claudeOutput, mergeable, presetPrUrl }) {
    console.log(`\n=== 场景：${label} ===`);
    const workBranch = `cc/e2e-${label}-${Date.now()}`;
    const draft = await db.createTask(pool, {
      projectId: project.id, title: `finalize e2e ${label}`, description: `原始需求：${label} 场景的任务描述。`,
      baseBranch: "main", workBranch, targetBranch: "main", submitMode: "pr",
      autoMergePr: true, autoReply: false, autoDecisionHints: "", model: "default", dynamicWorkflow: false
    });
    await db.createTaskRepos(pool, draft.id, [{ projectRepoId, role: "main", relativePath: ".", baseBranch: "main", workBranch, targetBranch: "main", subStatus: "pending" }]);
    await pool.query(`UPDATE tasks SET status='running', claimed_by=$2, claimed_at=now(), started_at=now() WHERE id=$1`, [draft.id, workerId]);
    // 模拟打回重跑：该仓 PR 已存在（pr_url 已落库）→ finalize 走「复用 + 刷新正文」分支。
    if (presetPrUrl) await pool.query(`UPDATE task_repos SET pr_url=$2, sub_status='pr_created' WHERE task_id=$1`, [draft.id, presetPrUrl]);
    const task = (await pool.query(`SELECT * FROM tasks WHERE id=$1`, [draft.id])).rows[0];

    // 建任务 worktree（主仓 role）+ 未提交改动（让 finalize 自己 commit）
    const wtPath = path.join(checkout, ".claude", "worktrees", `worktree-${task.id}`);
    git(["-C", checkout, "fetch", "origin"], undefined);
    git(["-C", checkout, "worktree", "add", "--force", "-B", workBranch, wtPath, "origin/main"]);
    await writeFile(path.join(wtPath, "s.txt"), `change for ${label}\n`, "utf8");

    const taskRepos = await db.listTaskRepos(pool, task.id);
    const ctxs = taskRepos.map((tr) => ({ ...tr, repo_url: bare }));

    const capture = path.join(tmpRoot, `gh-${label}.jsonl`);
    process.env.FAKE_GH_CAPTURE = capture;
    process.env.FAKE_GH_MERGEABLE = mergeable ? "true" : "false";
    process.env.NODE_OPTIONS = `--require "${hookOpt}"`;
    try {
      await finalizeTaskMultiRepo(config, task, checkout, wtPath, ctxs, claudeOutput);
    } finally {
      delete process.env.NODE_OPTIONS;
    }

    const events = (await pool.query(`SELECT event_type FROM task_events WHERE task_id=$1 ORDER BY created_at`, [task.id])).rows.map((e) => e.event_type);
    const notifs = (await pool.query(`SELECT DISTINCT type FROM notifications WHERE related_task_id=$1`, [task.id])).rows.map((n) => n.type);
    const ghCalls = existsSync(capture) ? readFileSync(capture, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    const createBody = ghCalls.find((c) => c.cmd === "create")?.body ?? "";
    const editBody = ghCalls.find((c) => c.cmd === "edit")?.body ?? "";
    return { task, events, notifs, ghCalls, createBody, editBody };
  }

  // ---- 场景 1：Test Plan 全通过 + 可合并 → 自动合并 ----
  {
    const r = await runScenario({ label: "pass-mergeable", claudeOutput: PASS_PLAN, mergeable: true });
    console.log(`  events: ${r.events.join(" → ")}`);
    console.log(`  gh: ${r.ghCalls.map((c) => c.cmd).join(",")}  notifs: ${r.notifs.join(",") || "—"}`);
    assert(r.events.includes("pr_created"), "建了 PR（pr_created）");
    assert(r.events.includes("auto_merged"), "门禁放行 → 自动合并（auto_merged）");
    assert(!r.events.includes("auto_merge_blocked") && !r.events.includes("auto_merge_skipped"), "无 blocked/skipped 事件");
    assert(r.ghCalls.some((c) => c.cmd === "merge"), "gh pr merge 被调用");
    assert(!r.notifs.includes("task_review_required"), "未发待人工确认通知");
    // 需求 1：PR body 渲染 Markdown
    assert(!r.createBody.includes("```text"), "PR body 不含 ```text 代码围栏（渲染 Markdown）");
    assert(r.createBody.includes("## Summary") && r.createBody.includes("## Test Plan"), "PR body 含 Summary / Test Plan 结构");
    assert(r.createBody.includes("原始需求"), "PR body 含折叠的原始任务需求");
  }

  // ---- 场景 2：Test Plan 有未测试项 → 门禁拦下 ----
  {
    const r = await runScenario({ label: "untested-blocked", claudeOutput: UNTESTED_PLAN, mergeable: true });
    console.log(`  events: ${r.events.join(" → ")}`);
    console.log(`  gh: ${r.ghCalls.map((c) => c.cmd).join(",")}  notifs: ${r.notifs.join(",") || "—"}`);
    assert(r.events.includes("pr_created"), "建了 PR（pr_created）");
    assert(r.events.includes("auto_merge_blocked"), "Test Plan 未全通过 → 拦截（auto_merge_blocked）");
    assert(!r.events.includes("auto_merged"), "未自动合并");
    assert(!r.ghCalls.some((c) => c.cmd === "view" || c.cmd === "merge"), "门禁在 mergeable 检查前就拦下（无 view/merge）");
    assert(r.notifs.includes("task_review_required"), "发了待人工确认通知（task_review_required）");
  }

  // ---- 场景 3：Test Plan 全通过但 PR 不可合并 → 跳过 + 通知（需求 3） ----
  {
    const r = await runScenario({ label: "unmergeable-notify", claudeOutput: PASS_PLAN, mergeable: false });
    console.log(`  events: ${r.events.join(" → ")}`);
    console.log(`  gh: ${r.ghCalls.map((c) => c.cmd).join(",")}  notifs: ${r.notifs.join(",") || "—"}`);
    assert(r.events.includes("pr_created"), "建了 PR（pr_created）");
    assert(r.events.includes("auto_merge_skipped"), "PR 不可合并 → 跳过自动合并（auto_merge_skipped）");
    assert(!r.events.includes("auto_merged"), "未自动合并");
    assert(r.ghCalls.some((c) => c.cmd === "view") && !r.ghCalls.some((c) => c.cmd === "merge"), "查了 mergeable 但未 merge");
    assert(r.notifs.includes("task_review_required"), "不可合并也发了待人工确认通知（需求 3）");
  }

  // ---- 场景 4：打回重跑（PR 已存在）→ 不重复 create，而是刷新正文为最新 Markdown ----
  {
    const r = await runScenario({ label: "reuse-refresh", claudeOutput: PASS_PLAN, mergeable: true, presetPrUrl: "https://github.com/fake/repo/pull/1" });
    console.log(`  events: ${r.events.join(" → ")}`);
    console.log(`  gh: ${r.ghCalls.map((c) => c.cmd).join(",")}  notifs: ${r.notifs.join(",") || "—"}`);
    assert(!r.ghCalls.some((c) => c.cmd === "create"), "复用已存在 PR，未重复 gh pr create");
    assert(r.ghCalls.some((c) => c.cmd === "edit"), "刷新正文：gh pr edit 被调用");
    assert(!r.editBody.includes("```text") && r.editBody.includes("## Summary") && r.editBody.includes("## Test Plan"),
      "刷新后的正文是渲染 Markdown（无 ```text、含结构化段）");
    assert(r.events.includes("auto_merged"), "刷新后照常走门禁 → 自动合并");
  }

  console.log(failures === 0 ? "\n✓ 端到端全部断言通过" : `\n✗ ${failures} 条断言失败`);
} finally {
  if (pool) await pool.end().catch(() => {});
  if (created) { await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)).catch(() => {}); console.log(`✓ dropped ${dbName}`); }
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
}
process.exit(failures === 0 ? 0 : 1);
