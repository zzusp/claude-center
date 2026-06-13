// Console 侧合并检测：判定 work_branch 是否已并入 target_branch。
// 方案见 docs/spec/task-merge-status-check.md。
//
// gh 优先 + git 祖先回退：有 PR 用 `gh pr view --json state` 判 MERGED（覆盖 squash/rebase）；
// gh 不可用（未装 / 未登录 / 出错）或无 PR 时，回退到远程 git 祖先判定（merge-base --is-ancestor）。
// 全程 GIT_TERMINAL_PROMPT=0 + 超时 + windowsHide，复用 branches/route.ts 同款执法，无凭据直接失败不卡交互。

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

export type MergeCheckInput = {
  repoUrl: string;
  prUrl: string | null;
  workBranch: string;
  targetBranch: string;
  ghCommand: string;
};

export async function detectBranchMerged(input: MergeCheckInput): Promise<boolean> {
  if (input.prUrl) {
    const viaGh = await mergedViaGh(input.ghCommand, input.prUrl);
    // gh 给出明确结论就用它；返回 null 表示 gh 不可用，落回 git 祖先判定。
    if (viaGh !== null) {
      return viaGh;
    }
  }
  return mergedViaGitAncestry(input.repoUrl, input.workBranch, input.targetBranch);
}

// gh pr view 判 PR 是否 MERGED。成功返回布尔；gh 不可用（未装/未登录/网络）返回 null 交给 git 回退。
async function mergedViaGh(ghCommand: string, prUrl: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync(ghCommand, ["pr", "view", prUrl, "--json", "state"], {
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: GIT_ENV
    });
    const pr = JSON.parse(stdout) as { state?: string };
    return pr.state === "MERGED";
  } catch {
    return null;
  }
}

// 远程 git 祖先判定：临时 bare 仓 fetch work/target 两 ref，merge-base --is-ancestor exit0 即 work 已并入
// target。exit1（未合并）与其它失败（分支不存在 / squash 删枝 / 网络）统一按未合并——无法确认即不自动验收。
async function mergedViaGitAncestry(repoUrl: string, workBranch: string, targetBranch: string): Promise<boolean> {
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "cc-merge-"));
    await runGit(["init", "--bare", "--quiet", dir]);
    await runGit([
      "-C",
      dir,
      "fetch",
      "--no-tags",
      "--quiet",
      repoUrl,
      `refs/heads/${workBranch}:refs/heads/work`,
      `refs/heads/${targetBranch}:refs/heads/target`
    ]);
    await runGit(["-C", dir, "merge-base", "--is-ancestor", "refs/heads/work", "refs/heads/target"]);
    return true;
  } catch {
    return false;
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function runGit(args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: GIT_ENV
  });
}
