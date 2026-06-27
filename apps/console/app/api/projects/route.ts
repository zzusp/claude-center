import {
  createProject,
  getPool,
  listConversations,
  listProjectsForUser,
  type Conversation,
  type ProjectRepo
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";
import { errorResponse, badRequest } from "../../lib/api";

export const dynamic = "force-dynamic";

// 列表附带每个项目的子仓清单：列表行要直接展开/添加子仓，避免再发 N 次 /api/projects/[id]/repos。
// 一次性 SELECT ... WHERE project_id = ANY($1) 拿全，再按 project_id 分组。
//
// `?include=conversations` 时额外附带每个项目下的对话清单（实时对话页用）：避免左侧项目树展开时再
// 单独拉 /api/conversations?projectId=X，进页面就把所有项目的会话一次取齐，展开即显。RBAC 与
// /api/conversations 一致：admin 看全部、其余看授权项目范围。
export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const includes = new Set((new URL(request.url).searchParams.get("include") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean));
    const withConversations = includes.has("conversations");
    const projects = await listProjectsForUser(getPool(), user);
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
    const conversationsByProject = new Map<string, Conversation[]>();
    if (withConversations && projects.length > 0) {
      const projectIds = projects.map((p) => p.id);
      // listConversations 已按 project_ids 白名单 + updated_at DESC 排序、join 项目/worker 名 +
      // 派生 last_message_at / generating，跟 /api/conversations 同一查询路径，避免行为分叉。
      const conversations = await listConversations(getPool(), {
        projectIds,
        limit: 1000
      });
      for (const c of conversations) {
        const list = conversationsByProject.get(c.project_id) ?? [];
        list.push(c);
        conversationsByProject.set(c.project_id, list);
      }
    }
    return NextResponse.json({
      projects: projects.map((p) => ({
        ...p,
        subRepos: subReposByProject.get(p.id) ?? [],
        ...(withConversations ? { conversations: conversationsByProject.get(p.id) ?? [] } : {})
      }))
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
