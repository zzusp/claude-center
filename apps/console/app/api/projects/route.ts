import { createProject, getPool } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../lib/session";

export async function POST(request: NextRequest) {
  const gate = await requirePermission("project.create");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const body = (await request.json()) as {
      name?: string;
      repoUrl?: string;
      defaultBranch?: string;
      description?: string;
    };

    if (!body.name?.trim() || !body.repoUrl?.trim()) {
      return NextResponse.json({ error: "Project name and repo URL are required" }, { status: 400 });
    }

    const project = await createProject(getPool(), {
      name: body.name.trim(),
      repoUrl: body.repoUrl.trim(),
      defaultBranch: body.defaultBranch?.trim() || "main",
      description: body.description?.trim() || ""
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
