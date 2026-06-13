import { createDirectCommand, getPool, type DirectCommandName } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../lib/session";

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

    return NextResponse.json({ command }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
