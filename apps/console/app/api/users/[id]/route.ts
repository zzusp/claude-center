import {
  countActiveAdmins,
  deleteUser,
  getPool,
  getUserById,
  ROLES,
  setUserPassword,
  setUserProjects,
  updateUser,
  type Role
} from "@claude-center/db";
import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "../../../lib/session";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("user.manage");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const admin = gate;
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      role?: string;
      displayName?: string;
      disabled?: boolean;
      password?: string;
      projectIds?: string[];
    };

    if (body.role && !ROLES.includes(body.role as Role)) {
      return NextResponse.json({ error: "无效角色" }, { status: 400 });
    }
    if (id === admin.id && body.disabled === true) {
      return NextResponse.json({ error: "不能停用自己的账号" }, { status: 400 });
    }

    const pool = getPool();
    const target = await getUserById(pool, id);
    if (!target) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    // 防自锁：不能把最后一个可用管理员降级或停用。
    const removesAdmin =
      target.role === "admin" && !target.disabled && ((body.role && body.role !== "admin") || body.disabled === true);
    if (removesAdmin && (await countActiveAdmins(pool)) <= 1) {
      return NextResponse.json({ error: "不能移除最后一个管理员" }, { status: 400 });
    }

    const updated = await updateUser(pool, id, {
      role: body.role as Role | undefined,
      displayName: body.displayName,
      disabled: body.disabled
    });
    if (!updated) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }

    if (body.password) {
      await setUserPassword(pool, id, body.password);
    }
    // admin 不挂项目（看全部）；非 admin 且传了 projectIds 才重置分配。
    if (updated.role === "admin") {
      await setUserProjects(pool, id, []);
    } else if (Array.isArray(body.projectIds)) {
      await setUserProjects(pool, id, body.projectIds);
    }

    return NextResponse.json({ user: updated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("user.manage");
  if (gate instanceof NextResponse) {
    return gate;
  }
  const admin = gate;
  try {
    const { id } = await params;
    if (id === admin.id) {
      return NextResponse.json({ error: "不能删除自己的账号" }, { status: 400 });
    }

    const pool = getPool();
    const target = await getUserById(pool, id);
    if (!target) {
      return NextResponse.json({ error: "用户不存在" }, { status: 404 });
    }
    if (target.role === "admin" && !target.disabled && (await countActiveAdmins(pool)) <= 1) {
      return NextResponse.json({ error: "不能删除最后一个管理员" }, { status: 400 });
    }

    await deleteUser(pool, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
