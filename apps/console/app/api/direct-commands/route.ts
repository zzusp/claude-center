import { createDirectCommand, getPool, type DirectCommandName } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../lib/session";
import { publishRelay, workerChannel } from "../../lib/relay-publish";

export async function POST(request: NextRequest) {
  const gate = await requirePermission("command.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const body = (await request.json()) as {
      workerId?: string;
      command?: DirectCommandName;
      text?: string;
      cwd?: string;
    };

    if (!body.workerId || !body.command || !body.text?.trim()) {
      return NextResponse.json({ error: "Worker, command and text are required" }, { status: 400 });
    }

    if (body.command !== "shell" && body.command !== "claude_prompt") {
      return NextResponse.json({ error: "Unsupported command" }, { status: 400 });
    }

    const command = await createDirectCommand(getPool(), {
      workerId: body.workerId,
      command: body.command,
      payload: {
        text: body.text.trim(),
        cwd: body.cwd?.trim() || undefined
      }
    });

    // 定向指令落库后推到该 worker 频道：Worker 收到即认领执行（不必等下一轮 tick）。
    publishRelay({
      channel: workerChannel(command.worker_id),
      type: "direct_command.upserted",
      entityId: command.id,
      payload: command
    });
    return NextResponse.json({ command }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
