import {
  createProject,
  getPool,
  listProjectsForUser,
  replaceProjectSubRepos,
  type ProjectRepo,
  type ProjectRepoInput
} from "@claude-center/db";
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
      subs?: Array<{ name?: string; repoUrl?: string; defaultBranch?: string; description?: string }>;
    };

    if (!body.name?.trim() || !body.repoUrl?.trim()) {
      return badRequest("Project name and repo URL are required");
    }

    const repoUrl = body.repoUrl.trim();
    const input = {
      name: body.name.trim(),
      repoUrl,
      defaultBranch: body.defaultBranch?.trim() || "main",
      description: body.description?.trim() || ""
    };

    // 新建项目时可一并填写子仓（子项目）。校验与 PUT /repos 对齐：repoUrl 必填、不可与主仓相同、不可重复。
    const subInputs: ProjectRepoInput[] = [];
    for (const sub of body.subs ?? []) {
      const subRepoUrl = sub.repoUrl?.trim();
      if (!subRepoUrl) {
        return badRequest("子仓必须填写 repoUrl");
      }
      if (subRepoUrl === repoUrl) {
        return badRequest(`子仓 ${sub.name?.trim() || subRepoUrl} 的 repoUrl 不可与主仓相同`);
      }
      subInputs.push({
        name: sub.name?.trim() || "",
        repoUrl: subRepoUrl,
        defaultBranch: sub.defaultBranch?.trim() || "main",
        description: sub.description?.trim() || "",
        position: subInputs.length + 1
      });
    }

    // 无子仓：保持原行为（pool 直连）。有子仓：在一个事务里建项目 + 整批写子仓，保证原子性。
    if (subInputs.length === 0) {
      const project = await createProject(getPool(), input);
      return NextResponse.json({ project }, { status: 201 });
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const project = await createProject(client, input);
      await replaceProjectSubRepos(client, project.id, subInputs);
      await client.query("COMMIT");
      return NextResponse.json({ project }, { status: 201 });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return errorResponse(error);
  }
}
