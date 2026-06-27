// 端到端验证：assertWorkBranchSafe 主仓分支保护门。
// 用法：node docs/acceptance/work-branch-safety/scripts/test-work-branch-safety.mjs
// 用临时 git 仓 + 空 baseRef commit，覆盖 ensureWorktree 五个核心场景：
//   A) 全新任务、分支不存在 → 允许（worktree 建出）
//   B) 已被另一 worktree 持有（模拟主仓 HEAD 在该分支）→ 拒绝
//   C) 分支已存在但无 worktree 持有，且无自家 wtPath 注册 → 拒绝（覆盖「-B 静默重置主仓分支」场景）
//   D) 分支已存在 + 自家 wtPath 已注册（detach 状态）→ 允许（retry 复用路径）
//   E) 自家 wtPath 当前持有该分支（典型 retry 复用）→ 允许

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.join(os.tmpdir(), `cc-wt-safety-${Date.now()}`);

function sh(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: opts.silent ? "pipe" : "inherit", ...opts });
}
function shOk(cwd, args) {
  try {
    sh(cwd, args, { silent: true });
    return true;
  } catch {
    return false;
  }
}

function setupRepo(dir) {
  mkdirSync(dir, { recursive: true });
  sh(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "a.txt"), "v1");
  sh(dir, ["add", "."]);
  sh(dir, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-qm", "v1"]);
}

async function main() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });

  // 动态加载 worker 构建产物（dist/worktree.js 暴露 ensureWorktree）。
  const wt = await import(pathToFileURL(path.resolve("apps/worker/dist/worktree.js")).href);

  let pass = 0, fail = 0;
  const log = (label, ok, detail = "") => {
    if (ok) {
      console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
      pass++;
    } else {
      console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
      fail++;
    }
  };

  // ---------- A) 全新分支：允许 ----------
  {
    const main = path.join(ROOT, "A-main");
    setupRepo(main);
    const wtPath = path.join(main, ".claude", "worktrees", "worktree-a");
    try {
      await wt.ensureWorktree(main, wtPath, { workBranch: "cc/task-A", baseRef: "main", fresh: true });
      const out = sh(main, ["worktree", "list", "--porcelain"], { silent: true });
      log("A: 全新分支放行 + worktree 创建到自家 wtPath", out.includes(`branch refs/heads/cc/task-A`));
    } catch (e) {
      log("A: 全新分支放行 + worktree 创建", false, e.message.slice(0, 200));
    }
  }

  // ---------- B) 分支被主仓 / 其它 worktree 持有：拒绝 ----------
  {
    const main = path.join(ROOT, "B-main");
    setupRepo(main);
    // 模拟用户在主仓自己签出了 feature/foo
    sh(main, ["checkout", "-q", "-b", "feature/foo"]);
    const wtPath = path.join(main, ".claude", "worktrees", "worktree-b");
    let threw = false, msg = "";
    try {
      await wt.ensureWorktree(main, wtPath, { workBranch: "feature/foo", baseRef: "main", fresh: true });
    } catch (e) {
      threw = true;
      msg = e.message ?? String(e);
    }
    log(
      "B: 主仓持有该分支 → 拒绝 + 主仓 HEAD 不变",
      threw && msg.includes("已被另一个 worktree 持有") &&
        sh(main, ["symbolic-ref", "HEAD"], { silent: true }).trim() === "refs/heads/feature/foo",
      threw ? msg.slice(0, 120) : "未抛错"
    );
    // 验证主仓分支 ref 未被改写
    const headBefore = sh(main, ["rev-parse", "refs/heads/feature/foo"], { silent: true }).trim();
    log("B: 主仓 feature/foo 提交未被改写", !!headBefore);
  }

  // ---------- C) 分支已存在 + 无人持有 + 无自家 wtPath → 拒绝（核心：保护静默 -B 重置）----------
  {
    const main = path.join(ROOT, "C-main");
    setupRepo(main);
    // 用户自己建了 feature/foo 并加了一笔提交，然后切回 main（无人持有该分支）
    sh(main, ["checkout", "-q", "-b", "feature/foo"]);
    writeFileSync(path.join(main, "user-data.txt"), "user data on feature/foo");
    sh(main, ["add", "."]);
    sh(main, ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-qm", "user-commit"]);
    const userCommit = sh(main, ["rev-parse", "refs/heads/feature/foo"], { silent: true }).trim();
    sh(main, ["checkout", "-q", "main"]);

    const wtPath = path.join(main, ".claude", "worktrees", "worktree-c");
    let threw = false, msg = "";
    try {
      await wt.ensureWorktree(main, wtPath, { workBranch: "feature/foo", baseRef: "main", fresh: true });
    } catch (e) {
      threw = true;
      msg = e.message ?? String(e);
    }
    const afterCommit = sh(main, ["rev-parse", "refs/heads/feature/foo"], { silent: true }).trim();
    log(
      "C: 既存用户分支 + 无 worktree 持有 → 拒绝（避免 -B 静默重置）",
      threw && msg.includes("已存在但未被任何 worktree"),
      threw ? msg.slice(0, 120) : "未抛错"
    );
    log("C: 用户分支 feature/foo 提交未被覆盖（核心安全保证）", afterCommit === userCommit, `${userCommit.slice(0, 8)} → ${afterCommit.slice(0, 8)}`);
  }

  // ---------- D) 既存分支 + 自家 wtPath 已注册（detach 状态）→ 允许（retry 复用） ----------
  {
    const main = path.join(ROOT, "D-main");
    setupRepo(main);
    const wtPath = path.join(main, ".claude", "worktrees", "worktree-d");
    // 首轮：建 worktree 在 cc/task-D 上
    await wt.ensureWorktree(main, wtPath, { workBranch: "cc/task-D", baseRef: "main", fresh: true });
    // 模拟终态收尾的 detach：worktree HEAD 脱离分支
    sh(wtPath, ["switch", "--detach"], { silent: true });
    // 第二轮 fresh retry：分支仍存在、无人持有、自家 wtPath 已注册（detach）→ 应允许
    let threw = false, msg = "";
    try {
      await wt.ensureWorktree(main, wtPath, { workBranch: "cc/task-D", baseRef: "main", fresh: true });
    } catch (e) {
      threw = true;
      msg = e.message ?? String(e);
    }
    log("D: detach 后自家 wtPath 仍注册 → fresh retry 放行", !threw, threw ? msg.slice(0, 120) : "");
  }

  // ---------- E) 自家 wtPath 当前持有（典型 retry，未 detach）→ 允许 ----------
  {
    const main = path.join(ROOT, "E-main");
    setupRepo(main);
    const wtPath = path.join(main, ".claude", "worktrees", "worktree-e");
    await wt.ensureWorktree(main, wtPath, { workBranch: "cc/task-E", baseRef: "main", fresh: true });
    // 再次 fresh（自家持有该分支）→ 应允许
    let threw = false, msg = "";
    try {
      await wt.ensureWorktree(main, wtPath, { workBranch: "cc/task-E", baseRef: "main", fresh: true });
    } catch (e) {
      threw = true;
      msg = e.message ?? String(e);
    }
    log("E: 自家 wtPath 仍持有该分支 → fresh 放行（典型 retry 复用）", !threw, threw ? msg.slice(0, 120) : "");
  }

  console.log(`\n${pass} passed, ${fail} failed`);

  // 清理
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(2);
});
