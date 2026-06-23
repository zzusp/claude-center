import {
  addConversationMessage,
  createConversation,
  getPool,
  getProject,
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
      autoReply?: boolean;
      autoDecisionHints?: string;
      // 可选首条消息：填了则建会话后立即落一条 user 消息（无 scheduledAt 即时应答；有则定时发送）。
      firstMessage?: string;
      scheduledAt?: string;
    };
    if (!body.projectId || !body.workerId) {
      return badRequest("projectId、workerId 必填");
    }
    // 非 git 项目（vcs='none'）无分支概念：branch 可空（Worker 在 localPath 就地跑）。git 项目仍要求 branch。
    const project = await getProject(getPool(), body.projectId);
    if (!project) {
      return badRequest("项目不存在");
    }
    const isGit = project.vcs === "git";
    if (isGit && !body.branch?.trim()) {
      return badRequest("Git 项目对话必须指定 branch");
    }
    const branch = isGit ? body.branch!.trim() : "";
    // 定时发送时间（可选，仅在带首条消息时有意义）：必须可解析且为将来时间。
    const firstMessage = body.firstMessage?.trim() ?? "";
    let scheduledAt: string | null = null;
    const scheduledRaw = body.scheduledAt?.trim();
    if (scheduledRaw) {
      const when = new Date(scheduledRaw);
      if (Number.isNaN(when.getTime())) {
        return badRequest("定时发送时间格式无效");
      }
      if (when.getTime() <= Date.now()) {
        return badRequest("定时发送时间必须晚于当前时间");
      }
      scheduledAt = when.toISOString();
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
      branch,
      model,
      title: body.title?.trim() || "",
      autoReply: body.autoReply === true,
      autoDecisionHints: body.autoDecisionHints,
      createdBy: user.id
    });
    publishRelay({
      channel: projectChannel(conversation.project_id),
      type: "conversation.upserted",
      entityId: conversation.id,
      projectId: conversation.project_id,
      payload: conversation
    });
    // 可选首条消息：即时消息落库后 publish 让 worker 立即应答；定时消息落 'scheduled' 态、不 publish
    //（worker 不应在到点前应答），到点由 Console 调度器提升后下一轮 tick 认领。
    if (firstMessage) {
      const message = await addConversationMessage(getPool(), {
        conversationId: conversation.id,
        role: "user",
        body: firstMessage,
        scheduledAt
      });
      if (!scheduledAt) {
        publishRelay({
          channel: projectChannel(conversation.project_id),
          type: "conversation.message",
          entityId: conversation.id,
          projectId: conversation.project_id,
          seq: message.seq ?? undefined,
          payload: message
        });
      }
    }
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
