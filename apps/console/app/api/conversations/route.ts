import {
  createConversation,
  getPool,
  listConversations,
  listUserProjectIds,
  workerLinkedToProject,
  type TaskModel
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";
import { requireProjectScope } from "../../lib/access";
import { errorResponse, badRequest } from "../../lib/api";
import { projectChannel, publishRelay } from "../../lib/relay-publish";

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
      return badRequest("projectId、workerId、branch 必填");
    }
    const denied = await requireProjectScope(user, body.projectId, "无权访问该项目");
    if (denied) {
      return denied;
    }
    if (!(await workerLinkedToProject(getPool(), body.workerId, body.projectId))) {
      return badRequest("该 worker 未关联此项目，无法对话");
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
    publishRelay({
      channel: projectChannel(conversation.project_id),
      type: "conversation.upserted",
      entityId: conversation.id,
      projectId: conversation.project_id,
      payload: conversation
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
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
    return errorResponse(error);
  }
}
