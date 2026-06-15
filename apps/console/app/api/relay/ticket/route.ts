import { getPool, listProjects, listUserProjectIds } from "@claude-center/db";
import { projectChannel, signTicket } from "@claude-center/relay-client";
import { NextResponse } from "next/server";
import { requireUser } from "../../../lib/session";

export const dynamic = "force-dynamic";

// 浏览器订阅票据 TTL：够覆盖一次连接续期窗口，过期后前端重新取票再连。
const TICKET_TTL_MS = 5 * 60 * 1000;

// 签发 SSE 中转订阅票据：按登录态 + RBAC 算出可订阅的 project 频道，用 CLAUDE_CENTER_RELAY_SECRET 签名。
// relayUrl/secret 未配置时返回 { enabled:false }，前端据此退回纯轮询。relay 凭票据白名单放行频道、不查业务库。
export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  const user = gate;
  const url = process.env.CLAUDE_CENTER_RELAY_URL?.trim() || "";
  const secret = process.env.CLAUDE_CENTER_RELAY_SECRET?.trim() || "";
  if (!url || !secret) {
    return NextResponse.json({ enabled: false });
  }
  try {
    const projectIds =
      user.role === "admin"
        ? (await listProjects(getPool())).map((project) => project.id)
        : await listUserProjectIds(getPool(), user.id);
    const channels = projectIds.map(projectChannel);
    const ticket = signTicket({ uid: user.id, channels, exp: Date.now() + TICKET_TTL_MS }, secret);
    return NextResponse.json({ enabled: true, url, ticket, channels, ttlMs: TICKET_TTL_MS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
