import {
  createConversation,
  getPool,
  getWorker,
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
    // 新建对话前校验 worker 在线（last_seen_at 60s 内）：离线的 worker 即便订阅 relay 也认领不到，
    // 直接挡掉避免用户建了空对话又对着「无人应答」干等。
    const worker = await getWorker(getPool(), body.workerId);
    if (!worker) {
      return badRequest("worker 不存在");
    }
    if (worker.status !== "online") {
      return badRequest("该 worker 当前离线，无法新建对话");
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
// 可选 query 过滤：keyword（title/项目名/worker 名/branch ILIKE）、projectId、workerId。
export async function GET(request: NextRequest) {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  try {
    const projectIds = user.role === "admin" ? null : await listUserProjectIds(getPool(), user.id);
    const url = new URL(request.url);
    const keyword = url.searchParams.get("keyword");
    const projectId = url.searchParams.get("projectId");
    const workerId = url.searchParams.get("workerId");
    const conversations = await listConversations(getPool(), {
      projectIds,
      keyword,
      projectId,
      workerId
    });
    return NextResponse.json({ conversations });
  } catch (error) {
    return errorResponse(error);
  }
}
