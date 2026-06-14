import {
  createConversation,
  getPool,
  listConversations,
  listUserProjectIds,
  userHasProject,
  workerLinkedToProject,
  type TaskModel
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";

export const dynamic = "force-dynamic";

const MODELS = new Set(["default", "opus", "sonnet", "haiku"]);

// 新建实时对话：指定项目 + 分支 + worker（+ 模型）。复用 command.create 权限（与定向指挥同级，仅 admin）。
export async function POST(request: NextRequest) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const body = (await request.json()) as {
      projectId?: string;
      workerId?: string;
      branch?: string;
      model?: string;
      title?: string;
    };
    if (!body.projectId || !body.workerId || !body.branch?.trim()) {
      return NextResponse.json({ error: "projectId、workerId、branch 必填" }, { status: 400 });
    }
    if (user.role !== "admin" && !(await userHasProject(getPool(), user.id, body.projectId))) {
      return NextResponse.json({ error: "无权访问该项目" }, { status: 403 });
    }
    if (!(await workerLinkedToProject(getPool(), body.workerId, body.projectId))) {
      return NextResponse.json({ error: "该 worker 未关联此项目，无法对话" }, { status: 400 });
    }
    const model = (body.model && MODELS.has(body.model) ? body.model : "default") as TaskModel;
    const conversation = await createConversation(getPool(), {
      projectId: body.projectId,
      workerId: body.workerId,
      branch: body.branch.trim(),
      model,
      title: body.title?.trim() || "",
      createdBy: user.id
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

// 列对话：登录即可读，按项目范围过滤（admin 看全部）。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const projectIds = user.role === "admin" ? null : await listUserProjectIds(getPool(), user.id);
    const conversations = await listConversations(getPool(), { projectIds });
    return NextResponse.json({ conversations });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
