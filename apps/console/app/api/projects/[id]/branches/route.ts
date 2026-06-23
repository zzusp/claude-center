import { getPool, getProject, listProjectRepos } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requirePermission } from "../../../../lib/session";
import { requireProjectScope } from "../../../../lib/access";
import { errorResponse } from "../../../../lib/api";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 根据项目仓库地址远程拉取分支列表，供发布任务时搜索选择签出分支 / PR 目标分支。
// 不克隆仓库，只用 `git ls-remote --heads` 读取远端 refs；默认分支置顶。
// 多仓支持：?repo=<project_repos.id> 拉指定仓的分支；缺省走项目主仓（兼容老前端）。
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("task.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    // 项目隔离：非 admin 只能读分配给自己项目的分支，避免枚举他人项目。
    const denied = await requireProjectScope(user, id, "无权访问该项目");
    if (denied) {
      return denied;
    }
    const repoIdParam = request.nextUrl.searchParams.get("repo")?.trim();
    let repoUrl: string;
    let defaultBranch: string;
    if (repoIdParam) {
      const repos = await listProjectRepos(getPool(), id);
      const repo = repos.find((r) => r.id === repoIdParam);
      if (!repo) {
        return NextResponse.json({ error: "指定的仓不属于该项目" }, { status: 404 });
      }
      repoUrl = repo.repo_url;
      defaultBranch = repo.default_branch;
    } else {
      const project = await getProject(getPool(), id);
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      // 非 git 项目（无 repo_url）没有远程分支可拉，直接返回空列表（任务/对话表单据此隐藏分支选择）。
      if (project.vcs !== "git" || !project.repo_url) {
        return NextResponse.json({ branches: [] });
      }
      repoUrl = project.repo_url;
      defaultBranch = project.default_branch;
    }

    let stdout: string;
    try {
      const result = await execFileAsync("git", ["ls-remote", "--heads", repoUrl], {
        timeout: 20_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // GIT_TERMINAL_PROMPT=0：私有仓库无凭据时直接失败，避免 git 卡在交互式密码提示。
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      });
      stdout = result.stdout;
    } catch (error) {
      return NextResponse.json(
        { error: `拉取远程分支失败：${error instanceof Error ? error.message : String(error)}` },
        { status: 502 }
      );
    }

    const branches = stdout
      .split(/\r?\n/)
      .map((line) => line.split("\t")[1] ?? "")
      .filter((ref) => ref.startsWith("refs/heads/"))
      .map((ref) => ref.slice("refs/heads/".length));

    const unique = Array.from(new Set(branches));
    unique.sort((a, b) => {
      if (a === defaultBranch) return -1;
      if (b === defaultBranch) return 1;
      return a.localeCompare(b);
    });

    return NextResponse.json({ branches: unique });
  } catch (error) {
    return errorResponse(error);
  }
}
