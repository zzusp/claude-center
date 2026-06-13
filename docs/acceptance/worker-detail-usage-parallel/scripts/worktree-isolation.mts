import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// 从 repo 根运行：npx tsx docs/acceptance/worker-detail-usage-parallel/scripts/worktree-isolation.mts
import { runCommand } from "../../../../apps/worker/src/shell.ts";
import { ensureWorktree, gcWorktrees, removeWorktree, worktreePathFor } from "../../../../apps/worker/src/worktree.ts";

const tmp = path.join(os.tmpdir(), "cc-wt-test");
fs.rmSync(tmp, { recursive: true, force: true });
const repo = path.join(tmp, "repo");
const data = path.join(tmp, "data");
fs.mkdirSync(repo, { recursive: true });

await runCommand("git", ["init", "-b", "main", repo]);
await runCommand("git", ["-C", repo, "config", "user.email", "t@t"]);
await runCommand("git", ["-C", repo, "config", "user.name", "t"]);
fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
await runCommand("git", ["-C", repo, "add", "-A"]);
await runCommand("git", ["-C", repo, "commit", "-m", "init"]);

const config = { dataDir: data } as never;
const taskId = "task-abc";
const wt = worktreePathFor(config, taskId);

// 1) fresh：从 main 起一棵新工作分支工作树（两个 taskId 并发各自独立）。
await ensureWorktree(repo, wt, { workBranch: "work/abc", baseRef: "main", fresh: true });
const branch = (await runCommand("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
console.log("[fresh] .git存在:", fs.existsSync(path.join(wt, ".git")), "| 带出base文件:", fs.existsSync(path.join(wt, "a.txt")), "| 分支:", branch);

// 同项目第二棵工作树（并发隔离）
const wt2 = worktreePathFor(config, "task-def");
await ensureWorktree(repo, wt2, { workBranch: "work/def", baseRef: "main", fresh: true });
console.log("[concurrent] 第二棵独立工作树:", fs.existsSync(path.join(wt2, ".git")), "| 路径不同:", wt !== wt2);

// 2) 工作树内改动不落到主仓工作树（隔离）
fs.writeFileSync(path.join(wt, "b.txt"), "in-worktree\n");
console.log("[isolate] 改动只在工作树, 主仓无 b.txt:", !fs.existsSync(path.join(repo, "b.txt")));

// 3) recover：工作树已存在则复用
await ensureWorktree(repo, wt, { workBranch: "work/abc", fresh: false });
console.log("[recover] 复用已存在工作树:", fs.existsSync(path.join(wt, ".git")) && fs.existsSync(path.join(wt, "b.txt")));

// 4) removeWorktree：拆掉 wt2
await removeWorktree(repo, wt2);
console.log("[remove] wt2 已拆:", !fs.existsSync(path.join(wt2, ".git")));

// 5) gc：keep 为空 → 残留的 wt 被回收
await gcWorktrees(config, repo, new Set());
console.log("[gc] 空 keep 回收孤儿:", !fs.existsSync(path.join(wt, ".git")));

// 6) gc 保护：keep 含 taskId 时不删
await ensureWorktree(repo, wt, { workBranch: "work/abc", baseRef: "main", fresh: true });
await gcWorktrees(config, repo, new Set([taskId]));
console.log("[gc-keep] keep 含该任务则保留:", fs.existsSync(path.join(wt, ".git")));

fs.rmSync(tmp, { recursive: true, force: true });
console.log("[done]");
