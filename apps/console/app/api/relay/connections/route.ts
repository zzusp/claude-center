import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/session";
import { errorResponse } from "../../../lib/api";

export const dynamic = "force-dynamic";

// SSE 中转当前连接明细（admin only）：服务端持 publish token 代理调用 relay /connections，
// 把结果原样转发给前端。relay 未启用时返回 { enabled:false }，前端据此隐藏区块。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  if (gate.role !== "admin") {
    return NextResponse.json({ error: "仅管理员可查看" }, { status: 403 });
  }
  const url = process.env.CLAUDE_CENTER_RELAY_URL?.trim() || "";
  const token = process.env.CLAUDE_CENTER_RELAY_PUBLISH_TOKEN?.trim() || "";
  if (!url || !token) {
    return NextResponse.json({ enabled: false });
  }
  try {
    const upstream = await fetch(`${url.replace(/\/$/, "")}/connections`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store"
    });
    if (!upstream.ok) {
      return NextResponse.json(
        { enabled: true, error: `relay /connections HTTP ${upstream.status}` },
        { status: 502 }
      );
    }
    const data = (await upstream.json()) as {
      uptimeMs: number;
      eventSeq: number;
      clients: Array<{
        id: number;
        source: "worker" | "ticket";
        channels: string[];
        connectedAt: number;
        lastEventId?: string;
      }>;
    };
    return NextResponse.json({ enabled: true, ...data });
  } catch (error) {
    return errorResponse(error);
  }
}
