// 综合验证：① shell 修复(含空格参数不被拆) ② 工作树迁到项目 .claude/worktrees/ + 主仓干净 + GC 安全
// ③ session transcript 文件定位 ④ session 同步到 task_sessions(DB)。
// 需 DATABASE_URL 指向一次性临时库（含 018 迁移）、CLAUDE_CONFIG_DIR 指向临时 claude 配置目录。
// 跑法见 docs/acceptance/worker-session-jsonl/scripts/run.ps1。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runCommand } from "../../../../apps/worker/src/shell.ts";
import {
  worktreePathFor,
  worktreesRoot,
  ensureWorktree,
  gcWorktrees
} from "../../../../apps/worker/src/worktree.ts";
import { readSessionJsonl, startTaskSessionSync } from "../../../../apps/worker/src/session.ts";
import { getPool, upsertTaskSession, getTaskSession, closePool } from "@claude-center/db";

let failures = 0;
function ok(cond: boolean, label: string): void {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
}

const tmpRoot = path.join(os.tmpdir(), `cc-verify-sess-${Date.now()}`);
mkdirSync(tmpRoot, { recursive: true });
const repo = path.join(tmpRoot, "repo");
const cfgDir = process.env.CLAUDE_CONFIG_DIR!;

async function git(args: string[]): Promise<string> {
  const r = await runCommand("git", args, { timeoutMs: 60_000 });
  return r.stdout;
}

const COMMIT_MSG = "ClaudeCenter task: 发布 1.0.4 版本 (a b)";

try {
  // —— A. shell 修复：含空格的 commit message 不被拆 —— //
  console.log("[A] shell 修复（runCommand 默认 shell:false，空格参数完整）");
  mkdirSync(repo, { recursive: true });
  await git(["-C", repo, "init", "-b", "main"]);
  await git(["-C", repo, "config", "user.email", "v@e.test"]);
  await git(["-C", repo, "config", "user.name", "verify"]);
  writeFileSync(path.join(repo, "a.txt"), "hello\n", "utf8");
  await git(["-C", repo, "add", "--all"]);
  // 这是 finalizeTask 触发报错的同款调用；shell:true 时会报 pathspec 'task:' 不匹配。
  await runCommand("git", ["-C", repo, "commit", "-m", COMMIT_MSG], { timeoutMs: 60_000 });
  const subjA = (await git(["-C", repo, "log", "-1", "--format=%s"])).trim();
  ok(subjA === COMMIT_MSG, `commit message 完整保留：${JSON.stringify(subjA)}`);

  // —— B. 工作树迁移 + 主仓干净 + GC 安全 —— //
  console.log("[B] 工作树迁到 <repo>/.claude/worktrees/worktree-<id> + 主仓干净 + GC 安全");
  const taskId = randomUUID();
  const wt = worktreePathFor(repo, taskId);
  const expected = path.join(repo, ".claude", "worktrees", `worktree-${taskId}`);
  ok(wt === expected, `worktreePathFor → ${wt}`);
  ok(worktreesRoot(repo) === path.join(repo, ".claude", "worktrees"), "worktreesRoot 在项目 .claude/worktrees");

  await ensureWorktree(repo, wt, { workBranch: `cc/${taskId}`, baseRef: "main", fresh: true });
  ok(existsSync(path.join(wt, ".git")), "ensureWorktree 建出任务工作树");

  const mainStatus = (await git(["-C", repo, "status", "--porcelain"])).trim();
  ok(mainStatus === "", `主仓 status 干净（git 跳过已注册 linked worktree）：${JSON.stringify(mainStatus)}`);

  // 在工作树里走一遍 finalizeTask 同款 add+commit（含空格 message）
  writeFileSync(path.join(wt, "b.txt"), "world\n", "utf8");
  await git(["-C", wt, "add", "--all"]);
  await runCommand("git", ["-C", wt, "commit", "-m", COMMIT_MSG], { timeoutMs: 60_000 });
  const subjB = (await git(["-C", wt, "log", "-1", "--format=%s"])).trim();
  ok(subjB === COMMIT_MSG, "工作树内 commit message 完整");

  // GC 安全：dev slug 树 + 另一任务树（不在 keep）+ keep 中的本任务树
  const devWt = path.join(repo, ".claude", "worktrees", "dev-feature");
  await git(["-C", repo, "worktree", "add", "-b", "devbranch", devWt, "main"]);
  const taskId2 = randomUUID();
  const wt2 = worktreePathFor(repo, taskId2);
  await ensureWorktree(repo, wt2, { workBranch: `cc/${taskId2}`, baseRef: "main", fresh: true });

  await gcWorktrees(repo, new Set([taskId])); // 只保留 taskId
  ok(existsSync(wt), "GC 保留 keep 集中的任务树（worktree-<taskId>）");
  ok(!existsSync(wt2), "GC 删除不在 keep 的任务树（worktree-<taskId2>）");
  ok(existsSync(devWt), "GC 不碰 Claude Code dev 树（dev-feature，非 UUID 命名）");

  // —— C. session transcript 文件定位（encode(cwd) 目录最新 .jsonl）—— //
  console.log("[C] session 文件定位（CLAUDE_CONFIG_DIR/projects/<encode(cwd)>/<uuid>.jsonl）");
  const cwdForSession = wt; // 任务的 cwd（每任务唯一）
  const encoded = cwdForSession.replace(/[^a-zA-Z0-9]/g, "-");
  const projDir = path.join(cfgDir, "projects", encoded);
  mkdirSync(projDir, { recursive: true });
  const jsonlContent =
    JSON.stringify({ type: "user", message: { role: "user", content: "实现功能 X" } }) +
    "\n" +
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "好的，开始。" }] }
    }) +
    "\n";
  const olderFile = path.join(projDir, `${randomUUID()}.jsonl`);
  const newerFile = path.join(projDir, `${randomUUID()}.jsonl`);
  writeFileSync(olderFile, "OLD\n", "utf8");
  writeFileSync(newerFile, jsonlContent, "utf8");
  // 把 newer 的 mtime 调到更晚，确保选中它
  const now = Date.now() / 1000;
  utimesSync(olderFile, now - 100, now - 100);
  utimesSync(newerFile, now, now);
  const read = readSessionJsonl(cwdForSession);
  ok(read === jsonlContent, "readSessionJsonl 取到目录内最新 .jsonl 全文");
  ok(readSessionJsonl(path.join(repo, "no-such-cwd")) === null, "无 transcript 目录时返回 null");

  // —— D. session 同步到 DB（task_sessions）+ startTaskSessionSync 终态强制同步 —— //
  console.log("[D] session 同步落库（task_sessions）");
  const pool = getPool();
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name, repo_url) VALUES ($1,$2) RETURNING id`,
    [`verify-${Date.now()}`, `https://x/${randomUUID()}`]
  );
  const projectId = proj.rows[0]!.id;
  const mk = async (): Promise<string> => {
    const t = await pool.query<{ id: string }>(
      `INSERT INTO tasks (project_id, title, description, work_branch) VALUES ($1,$2,$3,$4) RETURNING id`,
      [projectId, "t", "d", "cc/x"]
    );
    return t.rows[0]!.id;
  };

  const dbTask = await mk();
  await upsertTaskSession(pool, dbTask, "line1\n");
  const g1 = await getTaskSession(pool, dbTask);
  ok(g1?.jsonl === "line1\n", "upsert+get：首次内容");
  await upsertTaskSession(pool, dbTask, "line1\nline2\n");
  const g2 = await getTaskSession(pool, dbTask);
  ok(g2?.jsonl === "line1\nline2\n", "upsert 覆盖：内容更新");

  // startTaskSessionSync → stop() 强制最终同步：把 C 的 transcript 落到另一个任务
  const dbTask2 = await mk();
  const stop = startTaskSessionSync(dbTask2, cwdForSession);
  await stop(); // 立即停 + 强制最终同步一次
  const g3 = await getTaskSession(pool, dbTask2);
  ok(g3?.jsonl === jsonlContent, "startTaskSessionSync.stop() 强制同步完整 transcript 入库");

  await closePool();
} finally {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAIL`}`);
process.exit(failures === 0 ? 0 : 1);
