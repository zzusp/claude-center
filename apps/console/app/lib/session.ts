import { getPool, getSessionUser, permissionsForRole, type Permission, type User } from "@claude-center/db";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

// 服务端鉴权工具：登录会话 cookie 解析 + 路由门禁。仅在服务端（route handler / 服务端组件）使用。
export const SESSION_COOKIE = "cc_session";
export const SESSION_TTL_DAYS = 7;

export type AuthUser = User & { permissions: Permission[] };

// 传给客户端 Dashboard 的精简用户信息（不含敏感字段）。
export type CurrentUser = {
  id: string;
  username: string;
  displayName: string;
  role: User["role"];
  permissions: Permission[];
};

export async function getCurrentUser(): Promise<AuthUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }
  const user = await getSessionUser(getPool(), token);
  if (!user) {
    return null;
  }
  return { ...user, permissions: permissionsForRole(user.role) };
}

export function toCurrentUser(user: AuthUser): CurrentUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role,
    permissions: user.permissions
  };
}

// 路由门禁：返回 AuthUser 或一个 NextResponse（401/403）。
// 用法：const gate = await requireUser(); if (gate instanceof NextResponse) return gate;
export async function requireUser(): Promise<AuthUser | NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  return user;
}

export async function requirePermission(permission: Permission): Promise<AuthUser | NextResponse> {
  const gate = await requireUser();
  if (gate instanceof NextResponse) {
    return gate;
  }
  if (!gate.permissions.includes(permission)) {
    return NextResponse.json({ error: "权限不足" }, { status: 403 });
  }
  return gate;
}
