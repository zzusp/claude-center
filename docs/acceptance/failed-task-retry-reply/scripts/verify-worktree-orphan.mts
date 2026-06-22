// 行为验证（goal 1）：worktree 已存在 / 残留时 ensureWorktree 不再撞 `fatal: '<path>' already exists`，
// 而是按预期复用或重建。直接驱动 worker 真实代码 apps/worker/src/worktree.ts 的 ensureWorktree。
//
// 跑法：npx tsx docs/acceptance/failed-task-retry-reply/scripts/verify-worktree-orphan.mts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureWorktree, worktreePathFor } from "../../../../apps/worker/src/worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`✓ ${label}`);
}
function isRegistered(localPath: string, wtPath: string): boolean {
  const out = execFileSync("git", ["-C", localPath, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  const target = path.resolve(wtPath);
  return out.split(/\r?\n/).some((l) => l.startsWith("worktree ") && path.relative(path.resolve(l.slice(9).trim()), target) === "");
}

const root = mkdtempSync(path.join(os.tmpdir(), "wt-verify-"));
const main = path.join(root, "main");
mkdirSync(main, { recursive: true });

async function main_() {
  // 主仓：一个 commit + 工作分支（模拟任务的 work_branch 已建）。
  git(main, ["init", "-q"]);
  git(main, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const taskId = "2ee00794-3e52-4ecb-88a9-be179eaf3b2a";
  const workBranch = `cc/task-${taskId}`;
  git(main, ["branch", workBranch]);
  const wt = worktreePathFor(main, taskId);

  // ---- 用例 A：recover（fresh=false）撞「孤儿残留目录」（注册已丢、目录非空、无 .git）----
  // 复现真实失败现场：worktree 注册被 prune 掉但目录残留 → 旧代码会 `worktree add` 撞 already exists。
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, "leftover.txt"), "orphan content");
  assert(existsSync(wt) && !existsSync(path.join(wt, ".git")), "A 前置：孤儿目录存在且无 .git");
  await ensureWorktree(main, wt, { workBranch, fresh: false });
  assert(existsSync(path.join(wt, ".git")), "A：recover 撞孤儿目录后已重建出有效工作树（.git 存在）");
  assert(isRegistered(main, wt), "A：工作树已注册到主仓");

  // ---- 用例 B：recover 复用已存在的有效工作树（持有未提交改动，不应被重建丢弃）----
  writeFileSync(path.join(wt, "uncommitted.txt"), "work in progress");
  const gitFileBefore = readFileSync(path.join(wt, ".git"), "utf8");
  await ensureWorktree(main, wt, { workBranch, fresh: false });
  assert(existsSync(path.join(wt, "uncommitted.txt")), "B：复用已存在工作树，未提交改动保留（未被重建丢弃）");
  assert(readFileSync(path.join(wt, ".git"), "utf8") === gitFileBefore, "B：复用未重建（.git 指针不变）");

  // ---- 用例 C：fresh（fresh=true）撞「孤儿残留目录」----
  git(main, ["worktree", "remove", "--force", wt]);
  git(main, ["worktree", "prune"]);
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, "leftover2.txt"), "orphan content 2");
  assert(existsSync(wt) && !existsSync(path.join(wt, ".git")), "C 前置：孤儿目录存在且无 .git");
  await ensureWorktree(main, wt, { workBranch, baseRef: workBranch, fresh: true });
  assert(existsSync(path.join(wt, ".git")), "C：fresh 撞孤儿目录后已重建出有效工作树（.git 存在）");
  assert(!existsSync(path.join(wt, "leftover2.txt")), "C：fresh 重建后孤儿残留文件已被清掉");
  assert(isRegistered(main, wt), "C：fresh 工作树已注册到主仓");

  console.log("\nall worktree-orphan assertions passed");
}

try {
  await main_();
} finally {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}
