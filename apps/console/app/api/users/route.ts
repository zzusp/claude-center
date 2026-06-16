import { createUser, getPool, listUsersWithProjects, ROLES, setUserProjects, type Role } from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../lib/session";
import { errorResponse, badRequest } from "../../lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requirePermission("user.manage");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const users = await listUsersWithProjects(getPool());
    return NextResponse.json({ users });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const gate = await requirePermission("user.manage");
  if (gate instanceof NextResponse) {
    return gate;
  }
  try {
    const body = (await request.json()) as {
      username?: string;
      password?: string;
      role?: string;
      displayName?: string;
      projectIds?: string[];
    };

    if (!body.username?.trim() || !body.password || !body.role) {
      return badRequest("用户名、密码、角色必填");
    }
    if (!ROLES.includes(body.role as Role)) {
      return badRequest("无效角色");
    }

    const pool = getPool();
    const user = await createUser(pool, {
      username: body.username.trim(),
      password: body.password,
      role: body.role as Role,
      displayName: body.displayName?.trim() || ""
    });

    // admin 看全部项目，不分配；其余角色按勾选写入。
    if (body.role !== "admin" && Array.isArray(body.projectIds)) {
      await setUserProjects(pool, user.id, body.projectIds);
    }

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("duplicate key")) {
      return NextResponse.json({ error: "用户名已存在" }, { status: 409 });
    }
    return errorResponse(error);
  }
}
