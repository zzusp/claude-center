import { getPool, setWorkerWorkingState } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../../lib/session";
import { publishRelay, workerChannel } from "../../../../lib/relay-publish";

export const dynamic = "force-dynamic";

// web 端远程切换 worker 工作态。需 command.create（admin）；viaRemote=true 会在 DB 侧
// 校验该 worker 的 allow_remote_control——客户端不允许远程控制则 0 行更新，返回 403。
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as { state?: "idle" | "working" };
    if (body.state !== "idle" && body.state !== "working") {
      return NextResponse.json({ error: "state must be 'idle' or 'working'" }, { status: 400 });
    }

    const updated = await setWorkerWorkingState(getPool(), id, body.state, { viaRemote: true });
    if (!updated) {
      return NextResponse.json({ error: "该 Worker 未开启「允许 web 端远程开关」或不存在" }, { status: 403 });
    }

    // 推到该 worker 频道：Worker 收到即立刻按新工作态认领/停领（不必等下一轮 tick 读 DB）。
    publishRelay({
      channel: workerChannel(id),
      type: "worker.working_state",
      entityId: id,
      payload: { working_state: body.state }
    });
    return NextResponse.json({ ok: true, state: body.state }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
