import {
  getPool,
  getProject,
  listProjectRepos,
  replaceProjectSubRepos,
  syncMainProjectRepo,
  type ProjectRepoInput
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../../../lib/session";
import { requireProjectScope } from "../../../../lib/access";
import { errorResponse, badRequest } from "../../../../lib/api";

export const dynamic = "force-dynamic";

// 多仓任务（docs/spec/task-multi-repo.md §UI）：项目子仓清单读写。
// GET 返回主仓 + 子仓全部行；PUT 整批替换子仓清单（主仓由 syncMainProjectRepo 维护）。

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const { id } = await params;
    const denied = await requireProjectScope(user, id, "无权访问该项目");
    if (denied) {
      return denied;
    }
    // 一致性兜底：若 projects 已存在但主仓行因迁移前数据 / 历史路径漏写 → 同步一次。
    await syncMainProjectRepo(getPool(), id);
    const repos = await listProjectRepos(getPool(), id);
    return NextResponse.json({ repos });
  } catch (error) {
    return errorResponse(error);
  }
}

// PUT 入参：subs 数组（不含主仓——主仓由 projects 表镜像）。整批替换：缺失子仓被删，新增/改动 upsert。
// 删除子仓若仍有 task_repos 引用会因 ON DELETE RESTRICT 报错——返回 409 让用户先处理任务。
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("project.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const project = await getProject(getPool(), id);
    if (!project) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }
    const body = (await request.json()) as {
      subs?: Array<{
        relativePath?: string;
        repoUrl?: string;
        defaultBranch?: string;
        displayName?: string;
        position?: number;
      }>;
    };
    if (!Array.isArray(body.subs)) {
      return badRequest("subs 必须为数组");
    }
    const inputs: ProjectRepoInput[] = [];
    for (const sub of body.subs) {
      const relativePath = sub.relativePath?.trim();
      const repoUrl = sub.repoUrl?.trim();
      const defaultBranch = sub.defaultBranch?.trim() || "main";
      const displayName = sub.displayName?.trim() || relativePath || "";
      const position = Number.isFinite(sub.position) ? Number(sub.position) : inputs.length + 1;
      if (!relativePath || !repoUrl) {
        return badRequest("子仓必须填写 relativePath 与 repoUrl");
      }
      if (repoUrl === project.repo_url) {
        return badRequest(`子仓 ${relativePath} 的 repoUrl 不可与主仓相同`);
      }
      inputs.push({ relativePath, repoUrl, defaultBranch, displayName, position });
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await syncMainProjectRepo(client, id);
      await replaceProjectSubRepos(client, id, inputs);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      // ON DELETE RESTRICT 触发的删除拒绝：返回 409 + 明确指引。
      const msg = error instanceof Error ? error.message : String(error);
      if (/violates foreign key constraint/i.test(msg) && /task_repos/i.test(msg)) {
        return NextResponse.json(
          { error: "某些子仓仍被任务引用，无法删除。请先处理或删除相关任务后重试。" },
          { status: 409 }
        );
      }
      throw error;
    } finally {
      client.release();
    }

    const repos = await listProjectRepos(getPool(), id);
    return NextResponse.json({ repos });
  } catch (error) {
    return errorResponse(error);
  }
}
