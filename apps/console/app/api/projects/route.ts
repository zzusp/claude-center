import { createProject, getPool, listProjectsForUser } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireUser } from "../../lib/session";
import { errorResponse, badRequest } from "../../lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const projects = await listProjectsForUser(getPool(), gate);
    return NextResponse.json({ projects });
  } catch (error) {
    return errorResponse(error);
  }
}

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
      return badRequest("Project name and repo URL are required");
    }

    const project = await createProject(getPool(), {
      name: body.name.trim(),
      repoUrl: body.repoUrl.trim(),
      defaultBranch: body.defaultBranch?.trim() || "main",
      description: body.description?.trim() || ""
    });

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
