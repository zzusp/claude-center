import { createProject, getPool, listProjectsForUser, type ProjectRepo } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";
import { errorResponse, badRequest } from "../../lib/api";

export const dynamic = "force-dynamic";

// 列表附带每个项目的子仓清单：列表行要直接展开/添加子仓，避免再发 N 次 /api/projects/[id]/repos。
// 一次性 SELECT ... WHERE project_id = ANY($1) 拿全，再按 project_id 分组。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const projects = await listProjectsForUser(getPool(), gate);
    const subReposByProject = new Map<string, ProjectRepo[]>();
    if (projects.length > 0) {
      const result = await getPool().query<ProjectRepo>(
        `SELECT * FROM project_repos
          WHERE role = 'sub' AND project_id = ANY($1::uuid[])
          ORDER BY position ASC, created_at ASC`,
        [projects.map((p) => p.id)]
      );
      for (const row of result.rows) {
        const list = subReposByProject.get(row.project_id) ?? [];
        list.push(row);
        subReposByProject.set(row.project_id, list);
      }
    }
    return NextResponse.json({
      projects: projects.map((p) => ({ ...p, subRepos: subReposByProject.get(p.id) ?? [] }))
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission("project.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const body = (await request.json()) as {
      name?: string;
      repoUrl?: string;
      defaultBranch?: string;
      description?: string;
      vcs?: string;
    };

    // 非 git 项目（vcs='none'）：本地目录，不需要 repo_url / 分支。git 项目仍强校验 repo_url。
    const vcs = body.vcs === "none" ? "none" : "git";
    if (!body.name?.trim()) {
      return badRequest("Project name is required");
    }
    if (vcs === "git" && !body.repoUrl?.trim()) {
      return badRequest("Git project requires a repo URL");
    }

    const project = await createProject(getPool(), {
      name: body.name.trim(),
      repoUrl: vcs === "git" ? body.repoUrl!.trim() : null,
      defaultBranch: vcs === "git" ? body.defaultBranch?.trim() || "main" : "",
      description: body.description?.trim() || "",
      vcs
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
